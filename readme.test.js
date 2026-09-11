"use strict";
// The README must name every admin/user command the bridge handles and every
// key in config.example.yaml's bridge block. Summaries rot while module
// headers stay true (org README sweep, 2026-09-11); this holds the summary
// to the code and the example config.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const readme = fs.readFileSync(path.join(__dirname, "README.md"), "utf8");

test("every !command the bridge recognises is in the README", () => {
  const src = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const commands = [...new Set([...src.matchAll(/"(![a-z]+)"/g)].map((m) => m[1]))];
  assert.ok(commands.length >= 4, `expected commands, found ${commands.length}`);
  const missing = commands.filter((c) => !readme.includes("`" + c));
  assert.deepEqual(missing, [], `commands absent from README: ${missing.join(", ")}`);
});

test("every bridge.* key in config.example.yaml is in the README", () => {
  const example = fs.readFileSync(path.join(__dirname, "config.example.yaml"), "utf8");
  const lines = example.split("\n");
  const start = lines.findIndex((l) => /^bridge:/.test(l));
  assert.ok(start >= 0, "no bridge: block");
  const keys = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break;               // next top-level block
    const m = l.match(/^  ([a-z_]+):/);      // direct children only
    if (m) keys.push(m[1]);
  }
  assert.ok(keys.length > 0);
  const missing = keys.filter((k) => !readme.includes(k));
  assert.deepEqual(missing, [], `bridge keys absent from README: ${missing.join(", ")}`);
});
