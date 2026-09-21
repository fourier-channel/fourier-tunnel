"use strict";

const { decide } = require("./discordGateway.js");

// SHE IS VISIBLE. A gateway connection that does one job.
//
// Operator ruling 2026-09-21: "She does need to be present, I think." Presence
// is a gateway concept -- status is broadcast over the WebSocket -- so the
// REST-only acquisition path can poll perfectly and still leave her grey in
// every member list.
//
// THE CONNECTION ASKS FOR NOTHING. It identifies with intents: 0, which was
// MEASURED as accepted on 2026-09-21 rather than assumed: Discord sent READY and
// she was online for 45 seconds. Intents gate which EVENTS arrive and this wants
// none, so the socket is structurally incapable of reading a message. The
// privileged MESSAGE CONTENT grant belongs to the REST path and is not requested
// here. Presence and acquisition share a token and nothing else, which is what
// makes a bug in this file cost presence rather than data.
//
// EVERY DECISION THAT COULD COST THE TOKEN LIVES IN discordGateway.js, not here.
// This file owns the socket, the heartbeat and the wiring; it owns no policy.
// That split is deliberate: the policy is a pure function with twenty tests and
// two mutation checks behind it, and a socket is the one thing that cannot be
// tested that way.
//
// THE WebSocket IS INJECTED. Node 22+ ships a global; this container is pinned
// to node:20-slim by a transitive dependency, where one may not exist. Injecting
// it means the deployment picks (`globalThis.WebSocket` or the `ws` package)
// without this file guessing -- and it is also what lets the whole state machine
// be driven by a fake socket in tests, which is the only way heartbeats, zombies,
// resumes and budget exhaustion get exercised deterministically.

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

/** Close codes this client sends. Never 1000/1001 for a fault: Discord treats those as deliberate. */
const CLOSE_ZOMBIE = 4000;
const CLOSE_SHUTDOWN = 1000;

class PresenceClient {
  /**
   * @param {object} opts
   *   token           the bot token; never logged
   *   gatewayUrl      where a FRESH connection dials
   *   budget          an IdentifyBudget
   *   sessions        a SessionStore
   *   status          "online" | "idle" | "dnd" | "invisible"
   *   activity        optional string
   *   WebSocketImpl   the constructor to use
   *   log             (level, message, fields) -- never receives the token
   *   timers          { setTimeout, clearTimeout, setInterval, clearInterval }
   *   now             () => epoch ms
   */
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log || (() => {});
    this.timers = opts.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
    this.now = opts.now || Date.now;

    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    /** The jittered FIRST beat. Tracked because an untracked timer cannot be
     * cancelled: after stop() it would fire on a closed socket and start an
     * interval nothing owns. Found by the shutdown test, not by reading. */
    this.firstBeatTimer = null;
    this.awaitingAck = false;
    this.attempt = 0;
    this.ready = false;
    this.stopped = false;
    /** Set when the client gives up. A person has to act; nothing retries. */
    this.stoppedReason = null;
  }

  /** Connect for the first time. Resumes if a session was saved by a previous run. */
  async start() {
    this.stopped = false;
    this.stoppedReason = null;
    const saved = await this.opts.sessions.load();
    if (saved) {
      this.sessionId = saved.session_id;
      this.resumeUrl = saved.resume_gateway_url;
      this.seq = saved.seq;
      this.log("info", "a session was saved by a previous run; resuming rather than identifying");
      return this.#open(saved.resume_gateway_url, { resume: true });
    }
    return this.#identifyAndOpen(this.opts.gatewayUrl);
  }

  /** Clean shutdown. Distinguished from a fault by the close code. */
  stop() {
    this.stopped = true;
    this.#clearTimers();
    if (this.ws) {
      try { this.ws.close(CLOSE_SHUTDOWN, "shutdown"); } catch { /* already closing */ }
    }
  }

  async #identifyAndOpen(url) {
    // THE BUDGET IS CHECKED, AND THE IDENTIFY RECORDED, BEFORE THE SOCKET IS
    // OPENED. Recording afterwards loses every attempt that crashed in between,
    // and undercounting is the direction that empties the budget while the
    // ledger still says there is room.
    const check = await this.opts.budget.check(this.now());
    if (!check.ok) {
      this.#giveUp(check.reason);
      return;
    }
    await this.opts.budget.record(this.now(), "identify");
    this.log("info", "identifying", { remaining: check.remaining - 1 });
    return this.#open(url, { resume: false });
  }

  #open(url, { resume }) {
    const WS = this.opts.WebSocketImpl;
    const full = `${String(url).replace(/\/$/, "")}/?v=10&encoding=json`;
    this.pendingResume = resume;
    this.ready = false;
    this.awaitingAck = false;
    const ws = new WS(full);
    this.ws = ws;

    ws.addEventListener("message", (ev) => this.#onMessage(ev));
    ws.addEventListener("close", (ev) => { void this.#onClose(ev); });
    ws.addEventListener("error", () => {
      // The error event carries nothing useful and must never be used to print
      // anything that could embed the token. The close event follows with a code.
      this.log("warn", "socket error; the close event will carry the code");
    });
  }

  #send(payload) {
    if (!this.ws) return;
    try { this.ws.send(JSON.stringify(payload)); } catch { /* the close handler deals with it */ }
  }

  #onMessage(ev) {
    let p;
    try { p = JSON.parse(String(ev.data)); } catch { return; }
    if (typeof p.s === "number") this.seq = p.s;

    if (p.op === OP_HELLO) return this.#onHello(p.d);
    if (p.op === OP_HEARTBEAT_ACK) { this.awaitingAck = false; return; }
    if (p.op === OP_HEARTBEAT) { this.#beat(); return; }
    if (p.op === OP_RECONNECT) { this.askedToReconnect = true; this.#closeWith(CLOSE_ZOMBIE, "asked to reconnect"); return; }
    if (p.op === OP_INVALID_SESSION) {
      // d:true means the session can still be resumed; d:false means it cannot.
      this.invalidSession = p.d === true ? "resumable" : "unresumable";
      if (this.invalidSession === "unresumable") { this.sessionId = null; this.resumeUrl = null; }
      this.#closeWith(CLOSE_ZOMBIE, "invalid session");
      return;
    }
    if (p.op === OP_DISPATCH) return void this.#onDispatch(p);
  }

  #onHello(d) {
    const interval = d && d.heartbeat_interval;
    if (!interval) return;
    // The documented jittered first beat, so a fleet does not beat in lockstep.
    this.firstBeatTimer = this.timers.setTimeout(() => {
      this.firstBeatTimer = null;
      if (this.stopped || !this.ws) return;
      this.#beat();
      this.heartbeatTimer = this.timers.setInterval(() => {
        if (this.awaitingAck) {
          // ZOMBIE: a heartbeat went unacknowledged, so the connection is dead
          // in a way that still looks open. Documented remedy is to close with
          // any code other than 1000/1001 and reconnect.
          this.log("warn", "zombied: a heartbeat was never acknowledged");
          this.#closeWith(CLOSE_ZOMBIE, "heartbeat not acknowledged");
          return;
        }
        this.#beat();
      }, interval);
    }, Math.round(interval * 0.5));

    if (this.pendingResume && this.sessionId && this.seq !== null) {
      this.#send({ op: OP_RESUME, d: { token: this.opts.token, session_id: this.sessionId, seq: this.seq } });
      this.log("info", "resume sent", { seq: this.seq });
      return;
    }
    this.#send({
      op: OP_IDENTIFY,
      d: {
        token: this.opts.token,
        intents: 0,
        properties: { os: "linux", browser: "fourier-tunnel", device: "fourier-tunnel" },
        presence: {
          since: null,
          afk: false,
          status: this.opts.status || "online",
          activities: this.opts.activity ? [{ name: this.opts.activity, type: 3 }] : [],
        },
      },
    });
  }

  #beat() {
    this.awaitingAck = true;
    this.#send({ op: OP_HEARTBEAT, d: this.seq });
  }

  async #onDispatch(p) {
    if (p.t === "READY") {
      const d = p.d || {};
      this.sessionId = d.session_id || null;
      this.resumeUrl = d.resume_gateway_url || this.opts.gatewayUrl;
      this.ready = true;
      this.attempt = 0;
      await this.#saveSession();
      this.log("info", "ready", { user: (d.user && d.user.username) || "?", guilds: Array.isArray(d.guilds) ? d.guilds.length : 0 });
      return;
    }
    if (p.t === "RESUMED") {
      this.ready = true;
      this.attempt = 0;
      await this.#saveSession();
      this.log("info", "resumed -- no identify was spent");
    }
    // No intents, so nothing else should arrive. If it does, it is ignored
    // rather than handled: this connection is not an event source.
  }

  async #saveSession() {
    if (!this.sessionId || !this.resumeUrl || this.seq === null) return;
    await this.opts.sessions.save({
      session_id: this.sessionId,
      resume_gateway_url: this.resumeUrl,
      seq: this.seq,
      updated_at: new Date(this.now()).toISOString(),
    });
  }

  #closeWith(code, reason) {
    if (!this.ws) return;
    try { this.ws.close(code, reason); } catch { /* already closing */ }
  }

  async #onClose(ev) {
    this.#clearTimers();
    this.ready = false;
    const code = ev && typeof ev.code === "number" ? ev.code : 1006;
    if (this.stopped) {
      this.log("info", "closed after shutdown", { code });
      return;
    }

    const invalidSession = this.invalidSession;
    const askedToReconnect = this.askedToReconnect;
    this.invalidSession = undefined;
    this.askedToReconnect = undefined;

    const session = this.sessionId && this.resumeUrl && this.seq !== null
      ? { session_id: this.sessionId, resume_gateway_url: this.resumeUrl, seq: this.seq }
      : null;

    // The budget is consulted even when the likely answer is "resume", because
    // decide() must be able to refuse an identify it would otherwise fall
    // through to. Reading it is cheap; guessing is what costs a token.
    let budget;
    try {
      budget = await this.opts.budget.check(this.now());
    } catch (err) {
      this.#giveUp(`the identify budget could not be read, so connecting is refused: ${err.message}`);
      return;
    }

    const d = decide({ closeCode: code, invalidSession, askedToReconnect, session, budget, attempt: this.attempt });

    if (d.action === "stop") { this.#giveUp(d.reason); return; }

    this.attempt += 1;
    if (d.action === "resume") {
      this.log("info", "reconnecting to resume", { code, why: d.why });
      this.reconnectTimer = this.timers.setTimeout(() => {
        if (!this.stopped) this.#open(d.url, { resume: true });
      }, 1_000);
      return;
    }

    this.log("info", "reconnecting to identify", { code, why: d.why, delayMs: d.delayMs });
    this.reconnectTimer = this.timers.setTimeout(() => {
      if (!this.stopped) void this.#identifyAndOpen(this.opts.gatewayUrl);
    }, d.delayMs);
  }

  #giveUp(reason) {
    this.stopped = true;
    this.stoppedReason = reason;
    this.#clearTimers();
    // LOUD, and once. A presence client that quietly stops is a bot that is
    // simply offline, which is the state it exists to prevent and the one a
    // person is least likely to investigate.
    this.log("error", `presence STOPPED and will not retry: ${reason}`);
    if (this.opts.onStopped) this.opts.onStopped(reason);
  }

  #clearTimers() {
    if (this.firstBeatTimer !== null) { this.timers.clearTimeout(this.firstBeatTimer); this.firstBeatTimer = null; }
    if (this.heartbeatTimer !== null) { this.timers.clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.reconnectTimer !== null) { this.timers.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.awaitingAck = false;
  }
}

module.exports = { PresenceClient, OP_IDENTIFY, OP_RESUME, OP_HEARTBEAT, OP_HELLO, OP_DISPATCH };
