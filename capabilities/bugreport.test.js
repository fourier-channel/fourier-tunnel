"use strict";
// !bugreport, driven with fakes for Matrix and the REAL drop writer into a
// temporary queue -- what is asserted on disk is what the workbench would pull.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { publishEntry } = require("../drop.js");
const b = require("./bugreport.js");

const SELF = "@fourier:example.org";
const BOORU = "!booru:example.org";
const MATRIX = "!matrix:example.org";
const DM = "!dm:example.org";
const NOTIFY = "!operator-dm:example.org";
const OTHER = "!chat:example.org";

function rig(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bugreport-"));
  const q = path.join(root, "_drop", "bugreport");
  if (over.noQueue !== true) {
    fs.mkdirSync(path.join(q, "ready"), { recursive: true });
    fs.mkdirSync(path.join(q, "staging"), { recursive: true });
  }
  const r = {
    root, q, sent: [], audited: [], clock: 1790000000000,
    joined: new Set(over.joined || [BOORU, MATRIX, DM, NOTIFY, OTHER]),
    denied: new Set(over.denied || []),
    members: over.members || { [DM]: [SELF, "@user:example.org"], [OTHER]: [SELF, "@a:x", "@b:x"] },
    events: over.events || {},
  };
  r.cap = b.createBugReport({
    config: { rooms: { [BOORU]: "booru help", [MATRIX]: "matrix help" }, notifyRoom: NOTIFY, root },
    selfId: SELF,
    isBotLike: (u) => u.startsWith("@tunnel:") || u === SELF,
    joinedRooms: async () => { if (over.joinedFails) throw new Error("boom"); return [...r.joined]; },
    joinedMembers: async (room) => r.members[room] || null,
    sendText: async (room, text) => { r.sent.push({ room, text }); },
    getEvent: async (room, id) => r.events[id] || null,
    publishEntry,
    isDenied: (room) => r.denied.has(room),
    audit: (rec) => r.audited.push(rec),
    now: () => r.clock,
  });
  r.ready = () => fs.existsSync(path.join(q, "ready")) ? fs.readdirSync(path.join(q, "ready")).sort() : [];
  r.entry = (id) => JSON.parse(fs.readFileSync(path.join(q, "ready", id, "entry.json"), "utf8"));
  return r;
}

let n = 0;
function msg(body, room = BOORU, over = {}) {
  n += 1;
  return { type: "m.room.message", room_id: room, sender: "@user:example.org", event_id: `$ev${n}:example.org`,
           origin_server_ts: 1790000000000 + n, content: { msgtype: "m.text", body, ...(over.content || {}) }, ...over.top };
}

test("the id rule agrees with the workbench's (coherence/bugs.py report_id)", () => {
  // Vectors computed by fourier-coherence: bugs.report_id(event_id, ts).
  assert.equal(b.reportId("$4kPq9x:41chan.net", 1790000000000), "bug-20260921-0a1a26eb");
  assert.equal(b.reportId("$abc", 1758700000000), "bug-20250924-896f8c65");
});

test("a report in a help room is filed whole, acknowledged with its id, and announced", async () => {
  const r = rig();
  const ev = msg("!bugreport the upload button does nothing on my phone");
  assert.equal(await r.cap.handle(ev), true);
  const id = b.reportId(ev.event_id, ev.origin_server_ts);
  assert.deepEqual(r.ready(), [id]);
  const e = r.entry(id);
  assert.equal(e.v, 1);
  assert.equal(e.kind, "report");
  assert.equal(e.client, "matrix");
  assert.equal(e.room_label, "booru help");
  assert.equal(e.text, "the upload button does nothing on my phone");
  assert.equal(e.event_id, ev.event_id);
  assert.match(e.filed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(r.sent[0].room, BOORU);
  assert.match(r.sent[0].text, new RegExp(id));
  assert.equal(r.sent[1].room, NOTIFY);
  assert.match(r.sent[1].text, /^Developer, a new bug report: /);
  assert.ok(r.audited.some((a) => a.kind === "bugreport_filed" && a.id === id));
  assert.deepEqual(fs.readdirSync(path.join(r.q, "staging")), [], "nothing left half-built");
});

test("a replay of the same event is already filed, and the Developer is not told twice", async () => {
  const r = rig();
  const ev = msg("!bugreport tags vanish after save");
  await r.cap.handle(ev);
  await r.cap.handle(ev);
  assert.equal(r.ready().length, 1);
  assert.equal(r.sent.filter((s) => s.room === NOTIFY).length, 1);
});

test("a credential is refused before anything is written, and the record holds no text", async () => {
  const r = rig();
  assert.equal(await r.cap.handle(msg("!bugreport can't log in, my password is hunter2")), true);
  assert.deepEqual(r.ready(), []);
  assert.match(r.sent[0].text, /didn't keep it/);
  assert.match(r.sent[0].text, /change it now/);
  assert.equal(r.sent.filter((s) => s.room === NOTIFY).length, 0);
  assert.ok(!JSON.stringify(r.audited).includes("hunter2"), "the audit log kept the password");
});

test("an ordinary login complaint is NOT mistaken for a credential", async () => {
  const r = rig();
  await r.cap.handle(msg("!bugreport my password is incorrect even though I typed it right"));
  assert.equal(r.ready().length, 1);
});

test("empty, too long, and over the rate each get a reply and file nothing", async () => {
  const r = rig();
  await r.cap.handle(msg("!bugreport"));
  assert.match(r.sent.pop().text, /Put the details right after the command/);
  await r.cap.handle(msg("!bugreport " + "x".repeat(b.TEXT_MAX + 1)));
  assert.match(r.sent.pop().text, /4000/);
  for (let i = 0; i < 3; i++) await r.cap.handle(msg(`!bugreport thing ${i} broke`));
  assert.equal(r.ready().length, 3);
  await r.cap.handle(msg("!bugreport a fourth"));
  assert.equal(r.ready().length, 3);
  assert.match(r.sent.pop().text, /file another in about 60 minutes/);
  r.clock += 61 * 60 * 1000;
  await r.cap.handle(msg("!bugreport an hour later"));
  assert.equal(r.ready().length, 4);
});

test("in a DM with her it files; in another room she says where to go and files nothing", async () => {
  const r = rig();
  await r.cap.handle(msg("!bugreport from a DM", DM));
  const id = r.ready()[0];
  assert.equal(r.entry(id).room_label, "DM");
  await r.cap.handle(msg("!bugreport in the wrong room", OTHER));
  assert.equal(r.ready().length, 1);
  assert.match(r.sent.pop().text, /booru help or matrix help or in a DM with me/);
});

test("she never acts in a room she is not joined to, and ignores bots and other commands", async () => {
  const r = rig({ joined: [MATRIX, NOTIFY] });
  assert.equal(await r.cap.handle(msg("!bugreport not joined here", BOORU)), false);
  assert.equal(await r.cap.handle(msg("!bugreport from a bot", MATRIX, { top: { sender: "@tunnel:example.org" } })), false);
  assert.equal(await r.cap.handle(msg("!bugreports is not the command", MATRIX)), false);
  assert.equal(await r.cap.handle(msg("please !bugreport this", MATRIX)), false);
  assert.deepEqual(r.sent, []);
  assert.deepEqual(r.ready(), []);
});

test("a help room the COURIER was removed from still takes reports; other denied rooms stay silent", async () => {
  const r = rig({ denied: [BOORU, OTHER] });
  assert.equal(await r.cap.handle(msg("!bugreport still heard", BOORU)), true);
  assert.equal(r.ready().length, 1);
  assert.equal(await r.cap.handle(msg("!bugreport denied chat", OTHER)), false);
});

test("a missing queue is a failure she says out loud, never a silent success", async () => {
  const r = rig({ noQueue: true });
  await r.cap.handle(msg("!bugreport nowhere to put it"));
  assert.match(r.sent[0].text, /nothing was saved/);
  assert.ok(r.audited.some((a) => a.kind === "bugreport_failed" && /no drop queue/.test(a.reason)));
  assert.ok(!fs.existsSync(path.join(r.q, "ready")), "the writer created the queue");
});

test("the replied-to message rides along, unless it looks like a credential", async () => {
  const r = rig({ events: {
    "$orig:example.org": { sender: "@other:example.org", content: { body: "the gallery shows 0 posts" } },
    "$pw:example.org": { sender: "@other:example.org", content: { body: "password: sunshine99" } },
  } });
  const reply = (id) => ({ content: { "m.relates_to": { "m.in_reply_to": { event_id: id } } } });
  await r.cap.handle(msg("!bugreport this", BOORU, reply("$orig:example.org")));
  await r.cap.handle(msg("!bugreport and this", BOORU, reply("$pw:example.org")));
  const entries = r.ready().map(r.entry).sort((a, c) => a.text.localeCompare(c.text));
  assert.equal(entries[0].reply_to_withheld !== undefined, true);
  assert.equal(entries[0].reply_to_text, undefined);
  assert.equal(entries[1].reply_to_text, "the gallery shows 0 posts");
  assert.equal(entries[1].reply_to_sender, "@other:example.org");
});

test("the Developer's notice defangs links and shows invisible characters", async () => {
  const r = rig();
  await r.cap.handle(msg("!bugreport go to https://evil.example/login \u202e now"));
  const notice = r.sent.find((s) => s.room === NOTIFY).text;
  assert.ok(!notice.includes("https://"));
  assert.ok(notice.includes("\\u202e"));
  assert.match(notice, /^> go to hxxps\[:\/\/\]evil/m);
});

test("the heartbeat names each room she should hear, and never creates the queue", async () => {
  const r = rig({ joined: [MATRIX, NOTIFY], denied: [BOORU] });
  const hb = await r.cap.heartbeat();
  const onDisk = JSON.parse(fs.readFileSync(path.join(r.q, "heartbeat.json"), "utf8"));
  assert.deepEqual(onDisk, hb);
  assert.deepEqual(hb.rooms[BOORU], { label: "booru help", joined: false, denied: true });
  assert.deepEqual(hb.rooms[MATRIX], { label: "matrix help", joined: true, denied: false });
  assert.equal(hb.notify_room_joined, true);
  assert.match(r.sent.find((s) => s.room === NOTIFY).text, /I'm not in booru help/);
  const again = rig({ noQueue: true });
  await again.cap.heartbeat();
  assert.ok(!fs.existsSync(path.join(again.q, "ready")));
  assert.ok(!fs.existsSync(path.join(again.q, "heartbeat.json")));
});

test("fromConfig: off unless enabled, and loud about a bad room list or a missing mount", () => {
  const wiring = { root: "/state", selfId: SELF, audit: () => {} };
  assert.equal(b.fromConfig({ bridge: {} }, wiring), null);
  assert.equal(b.fromConfig({ bridge: { bugreport: { enabled: false } } }, wiring), null);
  assert.throws(() => b.fromConfig({ bridge: { bugreport: { enabled: true, rooms: { "#alias:x": "a" } } } }, wiring), /room IDs/);
  assert.throws(() => b.fromConfig({ bridge: { bugreport: { enabled: true, rooms: { [BOORU]: "a" } } } }, { ...wiring, root: "" }), /ONBOARDING_STATE_DIR/);
});
