"use strict";

// Tests for event -> task detection.

const test = require("node:test");
const assert = require("node:assert/strict");
const yaml = require("js-yaml");
const fs = require("node:fs");
const { tasksFor, earnableServerSide, validateCatalog, CLIENT_REPORT } = require("./taskDetect");
const { assignPoints, maxAchievable } = require("./fibonacci");

const CATALOG = yaml.load(fs.readFileSync(`${__dirname}/onboarding-tasks.example.yaml`, "utf8"));
const msg = (content) => ({ type: "m.room.message", content });

test("the shipped catalog is valid", () => {
  assert.equal(validateCatalog(CATALOG), true);
});

test("a plain message is chat, not a command", () => {
  assert.deepEqual(tasksFor(CATALOG, msg({ msgtype: "m.text", body: "hello" })), ["lobby_message"]);
});

test("a command is a command and NOT also chat", () => {
  // Otherwise "!help" would quietly award two tasks for one action.
  const got = tasksFor(CATALOG, msg({ msgtype: "m.text", body: "!help" }));
  assert.ok(got.includes("bot_command"));
  assert.ok(!got.includes("lobby_message"));
});

test("!join is both a command and the greeting reply", () => {
  const got = tasksFor(CATALOG, msg({ msgtype: "m.text", body: "!join" }));
  assert.ok(got.includes("bot_command"));
  assert.ok(got.includes("bot_join_reply"));
});

test("one event can prove several genuinely different things", () => {
  // A bold reply really is both a reply and formatting.
  const got = tasksFor(CATALOG, msg({
    msgtype: "m.text", body: "yes", formatted_body: "<b>yes</b>",
    "m.relates_to": { "m.in_reply_to": { event_id: "$x" } },
  }));
  assert.ok(got.includes("reply_quote"));
  assert.ok(got.includes("markdown_format"));
});

test("formatted_body without any markup is not formatting", () => {
  // Clients send formatted_body for plain text; awarding that would hand
  // everyone the point for typing "hi".
  const got = tasksFor(CATALOG, msg({ msgtype: "m.text", body: "hi", formatted_body: "hi" }));
  assert.ok(!got.includes("markdown_format"));
});

test("an edit is an edit and not a new message", () => {
  const got = tasksFor(CATALOG, msg({
    msgtype: "m.text", body: "* fixed", "m.relates_to": { rel_type: "m.replace", event_id: "$x" },
  }));
  assert.ok(got.includes("edit_message"));
  assert.ok(!got.includes("lobby_message"));
});

test("uploads, reactions, calls and joins are recognised", () => {
  assert.ok(tasksFor(CATALOG, msg({ msgtype: "m.image", url: "mxc://a/b" })).includes("upload_file"));
  assert.ok(tasksFor(CATALOG, msg({ msgtype: "m.file", url: "mxc://a/b" })).includes("upload_file"));
  assert.ok(tasksFor(CATALOG, { type: "m.reaction", content: {} }).includes("emoji_reaction"));
  assert.ok(tasksFor(CATALOG, { type: "m.call.invite", content: {} }).includes("voice_call"));
  assert.ok(tasksFor(CATALOG, { type: "m.room.member", content: { membership: "join" } }).includes("accept_invite"));
});

test("a client report is honoured ONLY for a client-detected task", () => {
  const report = (activity) => ({ type: CLIENT_REPORT, content: { activity } });
  assert.deepEqual(tasksFor(CATALOG, report("toggle_theme")), ["toggle_theme"]);
  // The 55-pointer is client-detected, so a client may claim it. That is the
  // spec's design and it is called out in the review document: the most
  // valuable task on the board is asserted by the client, not proven.
  assert.deepEqual(tasksFor(CATALOG, report("gallery_thread")), ["gallery_thread"]);
  // But a client cannot claim something the server is supposed to witness.
  assert.deepEqual(tasksFor(CATALOG, report("emoji_reaction")), []);
  assert.deepEqual(tasksFor(CATALOG, report("nonsense")), []);
});

test("the bot DM task needs context an event cannot carry", () => {
  const m = msg({ msgtype: "m.text", body: "hi" });
  assert.ok(!tasksFor(CATALOG, m).includes("bot_dm"));
  assert.ok(tasksFor(CATALOG, m, { isBotDm: true }).includes("bot_dm"));
});

test("most of the points cannot be earned without the client", () => {
  // Pins the number in the review document. 43 of 144 needed.
  const assigned = assignPoints(CATALOG.tasks);
  assert.equal(maxAchievable(assigned), 155);
  assert.equal(earnableServerSide(assigned), 43);
  assert.ok(earnableServerSide(assigned) < CATALOG.goal,
    "onboarding cannot be completed from Matrix events alone");
});

test("a catalog with a bogus rule is refused at load", () => {
  assert.throws(() => validateCatalog({ tasks: [{ id: "x", detect: "server:telepathy" }] }), /unknown detect rule/);
  assert.throws(() => validateCatalog({ tasks: [{ id: "x", detect: "client" }, { id: "x", detect: "client" }] }), /duplicate/);
  assert.throws(() => validateCatalog({ tasks: [] }), /empty/);
});
