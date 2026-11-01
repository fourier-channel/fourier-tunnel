"use strict";

// WORDS FOR THE ROOM, DETAIL FOR THE LOG -- enforced where text leaves.
//
// Operator rulings: no bot posts an IP address, a URL or a host:port into chat,
// tailnet included (2026-09-27: "puru-chan should not be posting IP addresses
// into chat :3 even if it is just a tailnet"); and the IP addresses and user
// agents of anyone live at most 7 days, in every store, "so long as we are not
// storing the IPs anywhere they can be accidentally leaked" (2026-11-01). A
// room event is the opposite of both: every member's client holds a copy, it
// federates, and it is kept for the life of the room.
//
// WHY A CHOKEPOINT, not only careful call sites. An @tunnel event of
// 2026-09-11 carries a visitor's user-agent string verbatim, and no line in
// this repo's history ever read a User-Agent header: it arrived inside foreign
// text, the way Puru-chan's address did (a raw error interpolated into a
// reason). Node's `fetch failed` carries `cause: connect ECONNREFUSED
// <ip>:<port>`, undici's parse error carries the URL, a Cloudflare or nginx
// error page carries the visitor's address and agent, and none of that is
// visible at the call site that wrote `${err.message}`. So every room message
// passes through guard() below, installed on bridge.getIntent() beside the
// denied-room guard, and a call site added tomorrow is covered today. The
// callers are fixed too (they say words and log the detail); this is the
// backstop for the one nobody has read yet.
//
// WHAT IS LOGGED WHEN SOMETHING IS REMOVED: the counts and the SCRUBBED text,
// never the original. A log is a store too, and this one cannot tell a
// visitor's address from a container's. On 41chan this container's stdout was
// docker's json-file driver, 50m x 3 (measured 2026-11-01), bounded by size
// and not by age; docker-compose.yaml now sends it to the journal (6 days),
// and even there a visitor's agent is not worth keeping for a week. The caller
// that built the text has the detail and logs it itself, where it knows what
// the detail is.
//
// STATE EVENTS ARE NOT TOUCHED. Tag state holds tag names and post ids that
// clients parse; rewriting "something:8080" inside a tag list would corrupt
// the data to protect a sentence that is not there. Only m.room.message bodies
// are prose.

const ADDRESS = "[address removed]";
const AGENT = "[user agent removed]";

// Products whose NAME/VERSION token is a user agent wherever it appears:
// browsers, HTTP libraries, crawlers and the Matrix clients people use here.
const AGENT_PRODUCTS = [
  "Mozilla", "Opera", "Dalvik", "AppleWebKit", "Chrome", "CriOS", "Safari", "Firefox", "FxiOS", "Edg", "Gecko",
  "curl", "Wget", "python-requests", "python-urllib", "aiohttp", "httpx", "okhttp", "Go-http-client",
  "axios", "node-fetch", "undici", "libwww-perl", "Java", "Apache-HttpClient", "Ruby", "Faraday",
  "Googlebot", "bingbot", "Discordbot", "Twitterbot", "facebookexternalhit", "Slackbot", "TelegramBot",
  "Element", "Riot", "Technetium", "SchildiChat", "FluffyChat", "Cinny", "Nheko", "Fractal", "Hydrogen",
  "matrix-nio", "matrix-js-sdk", "matrix-rust-sdk", "Synapse",
];

// One more NAME/VERSION or (comment) piece after the first: a browser agent is
// "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)
// Chrome/120.0 Safari/537.36" and the whole run goes, not its first word.
const AGENT_TAIL = String.raw`(?:\s*\([^)\n]*\)|\s+[A-Za-z][\w.+-]*\/[\w.+-]+)*`;
const KNOWN_AGENT = new RegExp(String.raw`\b(?:${AGENT_PRODUCTS.map((p) => p.replace(/[.+-]/g, "\\$&")).join("|")})\/\d[\w.+-]*${AGENT_TAIL}`, "gi");
// Any product token with a parenthesised comment holding a ";" -- the shape of
// every platform comment ("(Linux; Android 14)", "(iPhone; CPU iPhone OS ...)")
// whatever the product is called, so a client nobody listed is still caught.
const SHAPED_AGENT = new RegExp(String.raw`\b[A-Za-z][\w.+-]*\/\d[\w.+-]*\s*\([^)\n]*;[^)\n]*\)${AGENT_TAIL}`, "g");
// A header written out: "User-Agent: anything", "user_agent=...", JSON's
// "user_agent":"...". The value goes to the end of the quote or the line --
// not to a comma, because a browser agent has one inside "(KHTML, like Gecko)".
const AGENT_HEADER = /\buser[-_ ]?agent\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\n}]*)/gi;

// Addresses. mxc:// is NOT one: it is a Matrix content id, the thing the
// rescan and replace replies are about, and resolving it needs this
// homeserver's own authenticated media API.
const URL_RE = /\b(?!mxc:\/\/)[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g;
// IPv6 needs "::" or at least five groups, so a clock time ("01:54:30") is
// never one. A bracketed form with a port ("[::1]:8008") goes whole.
const IPV6 = /\[?(?:\b(?:(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?|(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4})|(?<![\w:])::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})(?![0-9a-z])\]?(?::\d{2,5})?/gi;
// name.tld:port, and the bare names docker gives containers (danbooru-web-1:3000).
// A Matrix id ("@saber:41chan.net", "!room:41chan.net") puts the colon BEFORE
// the domain, so it is never matched.
const HOST_PORT = /\b(?=[a-z0-9-]*[a-z])[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d{2,5}\b/gi;
const BARE_HOST_PORT = /\b(?:localhost|[a-z][a-z0-9-]*-\d+):\d{2,5}\b/gi;

const RULES = [
  // Agents first: a header line or a browser agent can hold a URL inside its
  // comment ("+http://www.google.com/bot.html"), and the whole agent should go
  // as one removal rather than leave its words around an address placeholder.
  ["agent", AGENT_HEADER, AGENT],
  ["agent", KNOWN_AGENT, AGENT],
  ["agent", SHAPED_AGENT, AGENT],
  ["address", URL_RE, ADDRESS],
  ["address", IPV4, ADDRESS],
  ["address", IPV6, ADDRESS],
  ["address", HOST_PORT, ADDRESS],
  ["address", BARE_HOST_PORT, ADDRESS],
];

/**
 * Remove every address and user agent from a piece of room text.
 * @param {string} text
 * @returns {{ text: string, removed: { address: number, agent: number } }}
 */
function scrubCounted(text) {
  const removed = { address: 0, agent: 0 };
  let out = String(text);
  for (const [kind, re, mark] of RULES) {
    out = out.replace(re, (m) => {
      removed[kind] += 1;
      return mark;
    });
  }
  return { text: out, removed };
}

/** Room text with addresses and user agents removed. */
function scrub(text) {
  return scrubCounted(text).text;
}

const PROSE = new Set(["m.text", "m.notice", "m.emote"]);

/**
 * A copy of m.room.message content with its prose scrubbed: body and
 * formatted_body of a text, notice or emote. Anything else is returned as it
 * came -- an image's body is its filename, and filenames are not private data
 * (operator 2026-11-01).
 */
function scrubContent(content) {
  if (!content || typeof content !== "object" || !PROSE.has(content.msgtype)) {
    return { content, removed: { address: 0, agent: 0 } };
  }
  const next = { ...content };
  const removed = { address: 0, agent: 0 };
  for (const key of ["body", "formatted_body"]) {
    if (typeof next[key] !== "string") continue;
    const r = scrubCounted(next[key]);
    next[key] = r.text;
    removed.address += r.removed.address;
    removed.agent += r.removed.agent;
  }
  return { content: next, removed };
}

/**
 * Wrap an Intent so no room message it sends can carry an address or a user
 * agent. sendText(room, text), sendMessage(room, content) and
 * sendEvent(room, "m.room.message", content) are scrubbed; everything else is
 * the intent's own method, bound to it as rooms.guard binds them.
 *
 * @param {object} intent
 * @param {{ log?: { warn: (s: string) => void } }} [deps]
 */
function guard(intent, deps = {}) {
  const log = deps.log || console;
  const report = (method, room, removed, text) => {
    if (!removed.address && !removed.agent) return;
    // The scrubbed text only: see the header for why the original is not
    // logged. It names the message so the caller can be found and fixed.
    log.warn(`[words] ${method} to ${room}: removed ${removed.address} address(es) and ${removed.agent} user agent(s) ` +
      `from a room message; the room got: ${JSON.stringify(String(text).slice(0, 300))}. ` +
      "Fix: the caller should say this in words and log its detail, not interpolate it.");
  };
  return new Proxy(intent, {
    get(target, prop) {
      // The receiver is the target, as in rooms.guard: a getter reading a
      // #private field through the proxy would throw.
      const value = Reflect.get(target, prop);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      if (prop === "sendText") {
        return function (room, text, ...rest) {
          const r = scrubCounted(text);
          report(prop, room, r.removed, r.text);
          return value.call(target, room, r.text, ...rest);
        };
      }
      if (prop === "sendMessage") {
        return function (room, content, ...rest) {
          const r = scrubContent(content);
          report(prop, room, r.removed, r.content && r.content.body);
          return value.call(target, room, r.content, ...rest);
        };
      }
      if (prop === "sendEvent") {
        return function (room, type, content, ...rest) {
          if (type !== "m.room.message") return value.call(target, room, type, content, ...rest);
          const r = scrubContent(content);
          report(prop, room, r.removed, r.content && r.content.body);
          return value.call(target, room, type, r.content, ...rest);
        };
      }
      return value.bind(target);
    },
  });
}

module.exports = { scrub, scrubCounted, scrubContent, guard, ADDRESS, AGENT };
