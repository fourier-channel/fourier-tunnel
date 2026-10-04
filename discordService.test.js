"use strict";

// The Discord service inside the tunnel: it starts only when configured, says
// why when it does not, and stops every loop at once on a refused token.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { startDiscord } = require("./discordService");

function capture() {
  const lines = [];
  return { lines, log: { log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) } };
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => { setTimeout(r, 20); });
  }
}

test("no discord block: nothing starts and nothing is said", () => {
  const c = capture();
  assert.equal(startDiscord({ config: {}, log: c.log }), null);
  assert.deepEqual(c.lines, []);
});

test("a discord block missing its parts does not start, and names every missing part", () => {
  const c = capture();
  const old = process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  try {
    const r = startDiscord({ config: { discord: { enabled: true, guilds: { "1551446880385245275": "41chan" } } }, log: c.log });
    assert.equal(r, null);
    const line = c.lines.join("\n");
    assert.match(line, /NOT STARTED/);
    assert.match(line, /DISCORD_BOT_TOKEN is not set/);
    assert.match(line, /state_dir is not set/);
    assert.match(line, /never 41chan or 4chan/);
    assert.match(line, /The Matrix bridge runs as normal/);
  } finally {
    if (old !== undefined) process.env.DISCORD_BOT_TOKEN = old;
  }
});

test("a refused token stops every loop at once and leaves presence.json saying so", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tunnel-dsvc-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const old = process.env.DISCORD_BOT_TOKEN;
  t.after(() => { if (old === undefined) delete process.env.DISCORD_BOT_TOKEN; else process.env.DISCORD_BOT_TOKEN = old; });
  process.env.DISCORD_BOT_TOKEN = "REVOKED";
  const c = capture();
  let calls = 0;
  const fetchImpl = async () => { calls++; return { status: 401, headers: { get: () => null }, json: async () => ({}) }; };
  const svc = startDiscord({ config: { discord: { enabled: true, state_dir: dir, guilds: { "1551446880385245275": "aichan" } } }, log: c.log, fetchImpl });
  assert.ok(svc);
  t.after(() => svc.stop());
  assert.ok(await waitFor(async () => c.lines.some((l) => /EVERY DISCORD LOOP STOPPED/.test(l))), c.lines.join("\n"));
  assert.ok(await waitFor(async () => {
    try { return JSON.parse(await fs.readFile(path.join(dir, "presence.json"), "utf8")).state === "stopped"; } catch { return false; }
  }));
  assert.equal(calls, 1, "one request, never retried");
});
