// "!bugreport <what happened>": a user tells Fourier-chan something is broken,
// and she files it where the Developer's workbench will find it.
//
// Design: fourier-basis docs/design/BUG_INTAKE.md. The other half -- the queue
// that pulls these reports and the supervised way they get fixed -- is
// fourier-coherence `coherence bugs` (coherence/bugs.py) on vesper.
//
// WHAT SHE DOES, IN ORDER, AND WHY THE ORDER IS THE DESIGN:
//
//   1. SCREEN FOR A CREDENTIAL, before anything is written. Canon: she never
//      stores a credential, and when someone pastes one she promises it was not
//      kept. Persisting first would make that promise false with no way back --
//      the queue is read by another machine and nothing in it is deleted.
//   2. PERSIST, with every file and directory fsynced, before she says a word.
//      The appservice library acknowledges a transaction to Synapse BEFORE
//      handlers run, so an event caught mid-handler by a restart is never
//      delivered again. "Filed as bug-..." is only true once the disk says so.
//   3. REPLY with the id, then tell the Developer in her DM with them. A
//      failed notice is logged and never unfiles the report.
//
// WHERE: the rooms named in bridge.bugreport.rooms (the help rooms), and a
// direct message with her. Anywhere else she says where to go instead. She
// acts only in rooms HER OWN joined-rooms list contains, read through a call
// that never auto-joins: the library's Intent joins a room before touching it,
// so sending somewhere she was removed from would quietly put her back.
//
// A DENIED ROOM is one the COURIER was removed from (rooms.js). That must not
// silence her: a help room where Neru-chan was asked to stop taking pictures is
// still a help room. So this runs before index.js drops denied-room events,
// sends through an intent the deny guard does not wrap, and does it only in
// configured help rooms and her DMs, where being joined was just checked.
//
// THE HEARTBEAT is how the other machine tells "nobody filed anything" from
// "she cannot hear": every five minutes she writes heartbeat.json beside the
// queue, naming each configured room and whether she is joined to it. The
// queue on vesper goes RED when it is stale or wrong. An intake that cannot
// hear must not look like a quiet one.
//
// EVERY DEPENDENCY IS INJECTED, as in avatar.js: this is a capability the bot
// hub will host once the tunnel migrates (BOT_HUB.md step 4), and a module
// handed its I/O can be moved by changing its import.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const COMMAND = "!bugreport";
const SOURCE = "bugreport";
const TEXT_MAX = 4000;
const NOTICE_TEXT_MAX = 600;
const PER_SENDER_PER_HOUR = 3;
const ALL_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;
const HEARTBEAT_MS = 5 * 60 * 1000;
const JOINED_CACHE_MS = 60 * 1000;
const WARN_EVERY_MS = 24 * HOUR_MS;

// Her lines. fourier-chan/canon/voice.md: warm, concise, one clear next action,
// at most one DSP metaphor, no infrastructure, no ETAs.
const LINES = {
  ack: (id) =>
    `Signal found! I've filed that as ${id} and passed it to the Developer's workbench. ` +
    `If you remember anything else -- the exact error text, or what you clicked just before -- ` +
    `send another !bugreport and mention ${id}.`,
  usage:
    "Happy to take a bug report! Put the details right after the command, like: " +
    "!bugreport the upload button does nothing on my phone. What you did, what you expected, " +
    "and what happened instead is the cleanest signal I can work from.",
  tooLong: (n) =>
    `That one's ${n} characters, and I can file up to ${TEXT_MAX} at a time. Could you trim it ` +
    "to the steps and the exact error text? Those carry most of what the Developer needs.",
  rateSender: (mins) =>
    "Thank you -- you've already filed a few this hour, and they're all waiting on the " +
    `Developer's workbench. You can file another in about ${mins} minute${mins === 1 ? "" : "s"}.`,
  rateAll: (mins) =>
    `I've taken a lot of reports this hour. Please try again in about ${mins} minute${mins === 1 ? "" : "s"}.`,
  credential:
    "Hold on -- that looks like it might include a password or a key, so I didn't keep it. " +
    "If it really was one, treat it as exposed and change it now; it happens to everyone once, " +
    "and it never needs to happen twice. A moderator can remove the message from this room. " +
    "Then send the report again, describing the problem without the secret.",
  failed:
    "Noise happens -- I couldn't file that just now, and nothing was saved. Please try again in " +
    "a few minutes, and if it keeps failing, message the Developer directly.",
  elsewhere: (labels) =>
    `I take bug reports in ${labels} or in a DM with me -- file it there and I'll pass it ` +
    "straight to the Developer's workbench.",
  notice: ({ id, sender, label, text, replySender }) =>
    `Developer, a new bug report: ${id}\nFrom ${sender} in ${label}:\n` +
    quoteLines(text) +
    (replySender ? `\n(in reply to a message from ${replySender})` : "") +
    "\nIt's queued on your workbench; start a session and ask it to work the bug queue whenever you're ready.",
  notJoined: (label, room) =>
    `Developer, I'm not in ${label} (${room}) any more, so bug reports filed there reach nobody. ` +
    "Invite me back when you can.",
};

/** The id rule. Restated in coherence/bugs.py report_id(); a test pins both to one vector. */
function reportId(eventId, originServerTs) {
  const day = new Date(originServerTs).toISOString().slice(0, 10).replace(/-/g, "");
  const hash = crypto.createHash("sha256").update(eventId, "utf8").digest("hex").slice(0, 8);
  return `bug-${day}-${hash}`;
}

/** "!bugreport ..." -> { text } ; anything else -> null. The command is a whole word. */
function parseCommand(body) {
  if (typeof body !== "string") return null;
  const m = body.match(/^\s*!bugreport(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { text: (m[1] || "").trim() };
}

// HEURISTIC, and said so. It catches the common shapes -- "password is x",
// "token: y", bearer headers, private-key blocks, provider token prefixes, and
// long mixed-class runs that look like keys -- and it will miss a bare word
// someone chose as a password. What it must never do is block an ordinary
// login complaint, which is most of what matrix help hears.
const SECRET_WORD = String.raw`(?:password|passwd|passphrase|pwd|token|api[ _-]?key|secret|access[ _-]?key)`;
const CREDENTIAL_PATTERNS = [
  // "password: x" / "token = x" -- the deliberate key-value form.
  [new RegExp(String.raw`\b${SECRET_WORD}\s*[:=]\s*["'\x60]?[^\s"'\x60]{4,}`, "i"), "a password or key given as a value"],
  // "my password is hunter2" -- but not "my password is incorrect": after
  // is/was the value must be quoted, or carry a digit or a symbol.
  [new RegExp(String.raw`\b${SECRET_WORD}\s+(?:is|was)\s+(?:["'\x60][^"'\x60]{3,}["'\x60]|(?=\S*[0-9!@#$%^&*_+=~])\S{4,})`, "i"),
   "a password or key given as a value"],
  [/\bbearer\s+[A-Za-z0-9._~+/-]{12,}/i, "a bearer token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b(?:syt|mat|mct|ghp|gho|github_pat|glpat|xox[bpas]|sk|rk)_[A-Za-z0-9_-]{10,}/, "a token with a known prefix"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an access key id"],
];

function looksLikeCredential(text) {
  if (typeof text !== "string" || !text) return null;
  for (const [re, what] of CREDENTIAL_PATTERNS) if (re.test(text)) return what;
  // A long unbroken run mixing cases and digits, that is not a Matrix id, an
  // mxc URI, a URL path segment or an event id -- the shape of a key.
  for (const m of text.matchAll(/(^|[\s"'`(=:])([A-Za-z0-9+/_-]{32,})(?=$|[\s"'`),.;])/g)) {
    const run = m[2];
    const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(run)).length;
    if (kinds === 3) return "a long key-shaped string";
  }
  return null;
}

/**
 * What the Developer's notice may show of a stranger's text: controls and
 * invisible formatting made visible, links defanged so no preview is fetched
 * and nothing reads as a button, and a length cap.
 */
function forNotice(text, cap = NOTICE_TEXT_MAX) {
  let s = "";
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (ch === "\n" || ch === "\t") { s += ch; continue; }
    // C0/C1 controls, bidi overrides and isolates, zero-width and BOM.
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x200b && cp <= 0x200f) ||
        (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff || cp === 0x061c) {
      s += "\\u" + cp.toString(16).padStart(4, "0");
      continue;
    }
    s += ch;
  }
  s = s.replace(/\b(https?):\/\//gi, (_, p) => p.replace(/t/gi, "x") + "[://]");
  return s.length > cap ? s.slice(0, cap) + " [...]" : s;
}

function quoteLines(text) {
  return forNotice(text).split("\n").map((l) => "> " + l).join("\n");
}

/** Fixed windows in memory: a restart grants at most one window's worth more. */
class RateLimit {
  constructor(now) { this.now = now; this.bySender = new Map(); this.all = []; }
  _prune(list) { const cut = this.now() - HOUR_MS; while (list.length && list[0] <= cut) list.shift(); }
  check(sender) {
    const mine = this.bySender.get(sender) || [];
    this._prune(mine); this._prune(this.all);
    const wait = (oldest) => Math.max(1, Math.ceil((oldest + HOUR_MS - this.now()) / 60000));
    if (mine.length >= PER_SENDER_PER_HOUR) return { ok: false, scope: "sender", mins: wait(mine[0]) };
    if (this.all.length >= ALL_PER_HOUR) return { ok: false, scope: "all", mins: wait(this.all[0]) };
    return { ok: true };
  }
  record(sender) {
    const t = this.now();
    const mine = this.bySender.get(sender) || [];
    mine.push(t); this.bySender.set(sender, mine); this.all.push(t);
  }
}

/**
 * @param {object} deps
 * @param {{rooms: Object<string,string>, notifyRoom: (string|null), root: string}} deps.config
 * @param {string} deps.selfId                     her mxid
 * @param {(userId: string) => boolean} deps.isBotLike
 * @param {() => Promise<string[]>} deps.joinedRooms           HER rooms; must never auto-join
 * @param {(room: string) => Promise<string[]|null>} deps.joinedMembers  null when unknown
 * @param {(room: string, text: string) => Promise<void>} deps.sendText  as her
 * @param {(room: string, eventId: string) => Promise<object|null>} deps.getEvent
 * @param {(root, source, id, files) => Promise<object>} deps.publishEntry
 * @param {(room: string) => boolean} deps.isDenied
 * @param {(record: object) => void} deps.audit
 * @param {() => number} [deps.now]
 */
function createBugReport(deps) {
  const { config, selfId, isBotLike, joinedRooms, joinedMembers, sendText, getEvent,
          publishEntry, isDenied, audit } = deps;
  const now = deps.now || Date.now;
  if (typeof audit !== "function") {
    throw new TypeError("createBugReport requires audit(): a report taken with no record cannot be traced");
  }
  if (!config || !config.root || !config.rooms || Object.keys(config.rooms).length === 0) {
    throw new TypeError("createBugReport requires config.root and at least one room in config.rooms");
  }
  const rooms = config.rooms;
  const labels = [...new Set(Object.values(rooms))].join(" or ");
  const rate = new RateLimit(now);
  const state = { startedAt: new Date(now()).toISOString(), lastReportAt: null, errors: 0,
                  joined: null, joinedAt: 0, warned: new Map(), timer: null };

  // The cache is written by a synchronous function, after the await has
  // produced a complete answer, so no reader can see half an update.
  function remember(set) {
    state.joined = set;
    state.joinedAt = now();
    return set;
  }

  async function herRooms(fresh = false) {
    if (!fresh && state.joined && now() - state.joinedAt < JOINED_CACHE_MS) return state.joined;
    return remember(new Set(await joinedRooms()));
  }

  async function say(room, text, kind) {
    try {
      await sendText(room, text);
    } catch (e) {
      state.errors += 1;
      audit({ kind: "bugreport_reply_failed", room, what: kind, error: e.message });
    }
  }

  async function venueOf(room, sender) {
    if (Object.prototype.hasOwnProperty.call(rooms, room)) return { label: rooms[room] };
    const members = await joinedMembers(room).catch(() => null);
    if (Array.isArray(members) && members.length === 2 && members.includes(selfId) && members.includes(sender)) {
      return { label: "DM" };
    }
    return null;
  }

  async function replyContext(room, content) {
    const rel = content && content["m.relates_to"];
    const inReply = rel && rel["m.in_reply_to"] && rel["m.in_reply_to"].event_id;
    const threadRoot = rel && rel.rel_type === "m.thread" ? rel.event_id || null : null;
    const out = { reply_to: inReply || null, thread_root: threadRoot };
    if (!inReply) return out;
    try {
      const ev = await Promise.race([
        getEvent(room, inReply),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), 5000);
          if (t.unref) t.unref();
        }),
      ]);
      const body = ev && ev.content && typeof ev.content.body === "string" ? ev.content.body : null;
      if (body) {
        if (looksLikeCredential(body)) {
          out.reply_to_withheld = "the replied-to message looked like it held a credential";
        } else {
          out.reply_to_text = body.slice(0, TEXT_MAX);
          out.reply_to_sender = ev.sender || null;
        }
      }
    } catch {
      // Context is a courtesy; a report is not refused for lacking it.
    }
    return out;
  }

  /** @returns {Promise<boolean>} true when the event was a bug report command, handled. */
  async function handle(event) {
    if (!event || event.type !== "m.room.message" || !event.content) return false;
    if (event.content.msgtype !== "m.text") return false;
    const cmd = parseCommand(event.content.body);
    if (!cmd) return false;
    const room = event.room_id;
    const sender = event.sender;
    if (!room || !sender || sender === selfId || isBotLike(sender)) return false;
    // A room the courier was removed from is left alone unless it is a help
    // room -- the deny list's "nothing else happens here" still holds elsewhere.
    const isHelpRoom = Object.prototype.hasOwnProperty.call(rooms, room);
    if (isDenied(room) && !isHelpRoom) return false;

    let mine;
    try {
      mine = await herRooms();
    } catch (e) {
      state.errors += 1;
      audit({ kind: "bugreport_failed", room, sender, reason: "could not read her joined rooms: " + e.message });
      return true;
    }
    if (!mine.has(room)) return false;   // she is not there to answer

    const venue = await venueOf(room, sender);
    if (!venue) {
      await say(room, LINES.elsewhere(labels), "elsewhere");
      audit({ kind: "bugreport_elsewhere", room, sender });
      return true;
    }
    if (!cmd.text) {
      await say(room, LINES.usage, "usage");
      return true;
    }
    if (cmd.text.length > TEXT_MAX) {
      await say(room, LINES.tooLong(cmd.text.length), "too_long");
      audit({ kind: "bugreport_refused", room, sender, reason: "too long", length: cmd.text.length });
      return true;
    }
    const cred = looksLikeCredential(cmd.text);
    if (cred) {
      // The text is NOT in this record: an audit log that kept the password
      // would be the storage the refusal just promised did not happen.
      await say(room, LINES.credential, "credential");
      audit({ kind: "bugreport_refused_credential", room, sender, shape: cred });
      return true;
    }
    const allowed = rate.check(sender);
    if (!allowed.ok) {
      await say(room, allowed.scope === "sender" ? LINES.rateSender(allowed.mins) : LINES.rateAll(allowed.mins), "rate");
      audit({ kind: "bugreport_refused", room, sender, reason: "rate " + allowed.scope });
      return true;
    }
    if (typeof event.event_id !== "string" || !Number.isInteger(event.origin_server_ts)) {
      state.errors += 1;
      await say(room, LINES.failed, "failed");
      audit({ kind: "bugreport_failed", room, sender, reason: "the event carried no event_id or origin_server_ts" });
      return true;
    }

    const id = reportId(event.event_id, event.origin_server_ts);
    const ctx = await replyContext(room, event.content);
    const entry = {
      v: 1, kind: "report", id, client: "matrix",
      sender, room_id: room, room_label: venue.label,
      event_id: event.event_id, origin_server_ts: event.origin_server_ts,
      text: cmd.text, ...ctx,
      filed_at: new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    const res = await publishEntry(config.root, SOURCE, id,
      { "entry.json": Buffer.from(JSON.stringify(entry, null, 2) + "\n") });
    if (!res.ok) {
      state.errors += 1;
      console.error(`[bugreport] could not file ${id}: ${res.reason}`);
      await say(room, LINES.failed, "failed");
      audit({ kind: "bugreport_failed", room, sender, id, reason: res.reason });
      return true;
    }
    rate.record(sender);
    state.lastReportAt = entry.filed_at;
    await say(room, LINES.ack(id), "ack");
    audit({ kind: "bugreport_filed", room, sender, id, already_queued: !!res.alreadyQueued });
    if (!res.alreadyQueued && config.notifyRoom && mine.has(config.notifyRoom)) {
      await say(config.notifyRoom, LINES.notice({ id, sender, label: venue.label, text: cmd.text,
                                                  replySender: ctx.reply_to_sender }), "notice");
    }
    return true;
  }

  /** Write heartbeat.json beside the queue. Never creates the queue. */
  async function heartbeat() {
    const dir = path.join(config.root, "_drop", SOURCE);
    let mine = null;
    try {
      mine = await herRooms(true);
    } catch (e) {
      state.errors += 1;
      console.error("[bugreport] heartbeat could not read her joined rooms:", e.message);
    }
    const hb = {
      v: 1, capability: "bugreport/1", at: new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z"),
      started_at: state.startedAt, last_report_at: state.lastReportAt, errors: state.errors,
      rooms: Object.fromEntries(Object.entries(rooms).map(([id, label]) =>
        [id, { label, joined: mine ? mine.has(id) : null, denied: isDenied(id) }])),
      notify_room_joined: config.notifyRoom ? (mine ? mine.has(config.notifyRoom) : null) : false,
    };
    try {
      const st = await fs.stat(path.join(dir, "ready"));
      if (!st.isDirectory()) throw new Error("not a directory");
      const tmp = path.join(dir, ".heartbeat.json.tmp");
      await fs.writeFile(tmp, JSON.stringify(hb, null, 2) + "\n");
      await fs.rename(tmp, path.join(dir, "heartbeat.json"));
    } catch (e) {
      console.error(`[bugreport] no queue at ${path.join(dir, "ready")}, so no heartbeat was written ` +
                    `and the workbench will report this intake as not listening: ${e.message}`);
    }
    // Tell the Developer, at most once a day per room, when she cannot hear a
    // help room -- the queue on vesper goes RED too, but a DM reaches a person.
    if (mine && config.notifyRoom && mine.has(config.notifyRoom)) {
      for (const [id, label] of Object.entries(rooms)) {
        if (mine.has(id)) continue;
        const last = state.warned.get(id) || 0;
        if (now() - last < WARN_EVERY_MS) continue;
        state.warned.set(id, now());
        await say(config.notifyRoom, LINES.notJoined(label, id), "not_joined");
        audit({ kind: "bugreport_room_not_joined", room: id });
      }
    }
    return hb;
  }

  function start() {
    void heartbeat();
    state.timer = setInterval(() => { void heartbeat(); }, HEARTBEAT_MS);
    if (state.timer.unref) state.timer.unref();
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  return { handle, heartbeat, start, stop };
}

/**
 * Read bridge.bugreport and build the capability, or return null when it is
 * off. Refuses loudly -- a misconfigured intake must not look like a quiet one.
 */
function fromConfig(config, wiring) {
  const cfg = config && config.bridge && config.bridge.bugreport;
  if (!cfg || cfg.enabled !== true) return null;
  const rooms = cfg.rooms || {};
  const bad = Object.keys(rooms).filter((r) => !/^![^:\s]+:\S+$/.test(r) || typeof rooms[r] !== "string");
  if (Object.keys(rooms).length === 0 || bad.length) {
    throw new Error("bridge.bugreport.rooms must map room IDs (!id:domain) to labels; got " +
                    JSON.stringify(rooms) + ". Fix config.yaml, or set bridge.bugreport.enabled: false.");
  }
  if (!wiring.root) {
    throw new Error("bridge.bugreport is enabled but ONBOARDING_STATE_DIR is unset, so there is no mounted " +
                    "state directory to file reports into. Fix the compose environment.");
  }
  return createBugReport({
    ...wiring,
    config: { rooms, notifyRoom: cfg.notify_room || null, root: wiring.root },
  });
}

module.exports = {
  COMMAND, SOURCE, TEXT_MAX, LINES, reportId, parseCommand, looksLikeCredential, forNotice,
  createBugReport, fromConfig,
};
