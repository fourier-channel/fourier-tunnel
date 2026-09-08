"use strict";

// Matrix event -> the onboarding task(s) it proves.
//
// Split from fibonacci.js because scoring and observing are different jobs:
// the scorer never sees an event and the detector never sees a point value.
//
// One event can prove SEVERAL tasks and all of them are returned. Someone who
// replies to a message in bold has genuinely both replied and used formatting,
// and since a task scores once ever, awarding both is not double-counting.
//
// Tasks whose rule is `client` are absent here on purpose. Nothing about a
// theme toggle or a search box reaches the homeserver, so those arrive as an
// explicit report from Technetium (CLIENT_REPORT). A catalog full of client
// rules is a catalog that mostly cannot be earned -- see earnableServerSide().

const CLIENT_REPORT = "net.41chan.onboarding.activity";

function isText(c) {
  return c.msgtype === "m.text" && typeof c.body === "string";
}

// Real formatting, not merely the presence of the field: Element sends
// formatted_body for a plain message too, and awarding a point for that would
// mean everyone gets it for typing "hi".
function looksFormatted(c) {
  return (
    typeof c.formatted_body === "string" &&
    /<(b|strong|em|i|code|pre|blockquote|ul|ol|a|h[1-6])\b/i.test(c.formatted_body)
  );
}

const RULES = {
  "server:call": (ev) => ev.type === "m.call.invite",
  "server:reaction": (ev) => ev.type === "m.reaction",
  "server:join": (ev) => ev.type === "m.room.member" && ev.content.membership === "join",
  "server:upload": (ev) =>
    ev.type === "m.room.message" && (ev.content.msgtype === "m.image" || ev.content.msgtype === "m.file"),
  "server:edit": (ev) =>
    ev.type === "m.room.message" &&
    (ev.content["m.relates_to"] || {}).rel_type === "m.replace",
  "server:reply": (ev) =>
    ev.type === "m.room.message" && !!(ev.content["m.relates_to"] || {})["m.in_reply_to"],
  "server:formatted": (ev) => ev.type === "m.room.message" && isText(ev.content) && looksFormatted(ev.content),
  "server:command": (ev) =>
    ev.type === "m.room.message" && isText(ev.content) && /^\s*!\w/.test(ev.content.body),
  "server:join_reply": (ev) =>
    ev.type === "m.room.message" && isText(ev.content) && /^\s*!join\b/i.test(ev.content.body),
  // A plain message: deliberately NOT a command and NOT an edit, so "!help"
  // does not also count as chatting.
  "server:message": (ev) =>
    ev.type === "m.room.message" &&
    isText(ev.content) &&
    !/^\s*!\w/.test(ev.content.body) &&
    (ev.content["m.relates_to"] || {}).rel_type !== "m.replace",
  // Context-dependent: the caller says whether this room is the bot's DM with
  // this user, because an event alone cannot tell.
  "server:bot_dm": (ev, ctx) => !!ctx.isBotDm && ev.type === "m.room.message",
};

/** Task ids this event proves, given the catalog. */
function tasksFor(catalog, event, ctx = {}) {
  if (!event || !event.type) return [];
  const ev = { ...event, content: event.content || {} };

  // An explicit client report names its own task, and is only honoured for a
  // task the catalog actually declares as client-detected -- otherwise a
  // client could award itself the 55-pointer by asking.
  if (ev.type === CLIENT_REPORT) {
    const id = ev.content.activity;
    const task = (catalog.tasks || []).find((t) => t.id === id);
    return task && task.detect === "client" ? [id] : [];
  }

  const out = [];
  for (const task of catalog.tasks || []) {
    const rule = RULES[task.detect];
    if (rule && rule(ev, ctx)) out.push(task.id);
  }
  return out;
}

/**
 * Points reachable from Matrix events alone, with no client cooperation.
 *
 * Exists to be reported at startup. The taxonomy puts its two most valuable
 * tasks (gallery threading, room creation) out of the bridge's reach, so this
 * number is a long way below the goal and an operator should know that before
 * wondering why nobody passes.
 */
function earnableServerSide(assignedTasks) {
  return assignedTasks
    .filter((t) => t.detect && t.detect.startsWith("server:"))
    .reduce((sum, t) => sum + t.points, 0);
}

function validateCatalog(catalog) {
  const tasks = catalog.tasks || [];
  if (!tasks.length) throw new Error("task catalog is empty");
  const seen = new Set();
  for (const t of tasks) {
    if (!t.id) throw new Error("a task has no id");
    if (seen.has(t.id)) throw new Error(`duplicate task id '${t.id}'`);
    seen.add(t.id);
    if (t.detect !== "client" && !RULES[t.detect]) {
      throw new Error(`task '${t.id}': unknown detect rule '${t.detect}'`);
    }
  }
  return true;
}

module.exports = { tasksFor, earnableServerSide, validateCatalog, RULES, CLIENT_REPORT };
