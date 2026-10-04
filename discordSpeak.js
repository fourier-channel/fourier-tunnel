"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { AuthFailed, ChannelRefused, Transient } = require("./discordAcquire");

// HER VOICE, AS THE OPERATOR SPEAKS THROUGH IT.
//
// Operator ruling 2026-10-04: "Yes, she should speak freely through me. Create
// an endpoint connection where I can send her direct text to post, along with
// the pause/resume as a toggle on the page." The page is fourier-sampling's
// panel (owner view only); this is the half that holds the Discord token.
//
// The two talk through a DIRECTORY, the shape this org already ruled for
// handing work between components (D-cac078): the panel writes a message into
// outbox/ready/ with one rename, and this worker sends it. So the bot's token
// never leaves this process and nothing else can speak as her -- the hub's
// rule, "the socket is the identity", kept by construction rather than by a
// second credential.
//
//   outbox/staging/<id>.json   the panel builds an entry here
//   outbox/ready/<id>.json     one rename publishes it; this worker sends it
//   outbox/sent/<id>.json      sent, with the Discord message id and whether
//                              reading it back confirmed it
//   outbox/failed/<id>.json    not sent, or not knowably sent, with the reason
//   speech.json                { paused }, written by the panel's toggle
//
// Rules that are not obvious:
//   - The pause is re-read before EVERY send, never cached. A toggle that takes
//     effect at the next restart is not a toggle.
//   - Only assigned channels. Free speech is what she says, not where.
//   - A send that MAY have landed is never repeated: Discord's 5xx or a dropped
//     connection can follow a message that was posted, and a retry would post
//     it twice in someone's channel. It goes to failed/ saying exactly that.
//   - Mentions of people work; @everyone, @here and role pings do not
//     (allowed_mentions), so a stray paste cannot page a whole server.
//   - The worker does not create the outbox. A missing queue means the panel
//     and this worker disagree about the path, and creating it on demand
//     would make that look like an idle queue (--init creates it on purpose).

const MAX_LEN = 2000;

function dirs(stateDir) {
  const root = path.join(stateDir, "outbox");
  return { root, staging: path.join(root, "staging"), ready: path.join(root, "ready"), sent: path.join(root, "sent"), failed: path.join(root, "failed") };
}

async function initOutbox(stateDir) {
  const d = dirs(stateDir);
  for (const p of [d.staging, d.ready, d.sent, d.failed]) await fs.mkdir(p, { recursive: true });
  return d;
}

/** The toggle. Never set means speaking: the panel writes the file on the first toggle. */
async function readSpeech(stateDir) {
  try {
    const s = JSON.parse(await fs.readFile(path.join(stateDir, "speech.json"), "utf8"));
    return { paused: s.paused === true, at: s.at || null, set: true };
  } catch (err) {
    if (err && err.code === "ENOENT") return { paused: false, at: null, set: false };
    // An unreadable toggle is a reason to be QUIET, not to talk: guessing
    // "not paused" from a corrupt file would ignore the one control that says stop.
    return { paused: true, at: null, set: true, unreadable: err.message };
  }
}

async function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await fs.rename(tmp, file);
}

/**
 * Send what is waiting, oldest first, unless paused.
 * Returns { paused, sent: [...], failed: [...], waiting }.
 */
async function processOutbox(opts) {
  const { http, stateDir } = opts;
  const allowed = new Set(opts.channels || []);
  const now = opts.now || (() => Date.now());
  const log = opts.log || ((m) => console.log(m));
  const d = dirs(stateDir);
  try {
    await fs.stat(d.ready);
  } catch {
    throw new Error(`no outbox at ${d.ready}. It is created once, deliberately (tools/discord-speak.js --init), never on demand: a missing one means the panel and the worker disagree about the path.`);
  }
  const names = (await fs.readdir(d.ready)).filter((n) => n.endsWith(".json")).sort();
  const out = { paused: false, sent: [], failed: [], waiting: names.length };

  for (const name of names) {
    const speech = await readSpeech(stateDir);
    if (speech.paused) {
      out.paused = true;
      if (speech.unreadable) log(`[speak] speech.json is unreadable (${speech.unreadable}); staying quiet until it is fixed`);
      break;
    }
    const file = path.join(d.ready, name);
    let entry;
    try {
      entry = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (err) {
      await fail(d, name, { raw: name }, `the entry is not readable JSON: ${err.message}`, now);
      out.failed.push(name);
      out.waiting--;
      continue;
    }
    const text = typeof entry.text === "string" ? entry.text : "";
    let refusal = null;
    if (!allowed.has(entry.channel)) refusal = `channel ${JSON.stringify(entry.channel)} is not one she is assigned to`;
    else if (!text.trim()) refusal = "the message is empty";
    else if (text.length > MAX_LEN) refusal = `the message is ${text.length} characters; Discord allows ${MAX_LEN}`;
    if (refusal) {
      await fail(d, name, entry, refusal, now);
      out.failed.push(name);
      out.waiting--;
      continue;
    }
    let msg;
    try {
      msg = await http.postJson(`/channels/${entry.channel}/messages`, { content: text, allowed_mentions: { parse: ["users"] } }, `channel ${entry.channel}`);
    } catch (err) {
      if (err instanceof AuthFailed) throw err;
      if (err instanceof ChannelRefused || err instanceof Transient) {
        await fail(d, name, entry, err.message, now);
        out.failed.push(name);
        out.waiting--;
        log(`[speak] ${name}: ${err.message}`);
        continue;
      }
      throw err;
    }
    // A 201 is evidence about the request. Reading the message back is the
    // evidence about the message.
    let verified = false;
    let note = null;
    try {
      const back = await http.getJson(`/channels/${entry.channel}/messages/${msg.id}`, `channel ${entry.channel}`);
      verified = back && back.id === msg.id && back.content === text;
      if (!verified) note = "read back, but the content differs from what was sent";
    } catch (err) {
      note = `sent, but reading it back failed: ${err.message}`;
    }
    await writeAtomic(path.join(d.sent, name), { ...entry, message_id: msg.id, verified, ...(note ? { note } : {}), sent_at: new Date(now()).toISOString() });
    await fs.rm(file, { force: true });
    out.sent.push({ name, message_id: msg.id, verified });
    out.waiting--;
    log(`[speak] sent ${name} to channel ${entry.channel} as message ${msg.id}${verified ? ", read back" : ` (${note})`}`);
  }
  return out;
}

async function fail(d, name, entry, reason, now) {
  await writeAtomic(path.join(d.failed, name), { ...entry, reason, failed_at: new Date(now()).toISOString() });
  await fs.rm(path.join(d.ready, name), { force: true });
}

module.exports = { processOutbox, initOutbox, readSpeech, dirs, MAX_LEN };
