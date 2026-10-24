"use strict";

// IP-ADDRESS IS OVERRIDDEN UNDER IP-CIDR, AND WHAT THAT COSTS.
//
// Dependabot #17 (GHSA-mwp4-54f8-5fhr): ip-address <= 10.3.0 reads an IPv4
// octet with a leading zero as decimal where resolvers read it as octal, so
// "010.0.0.1" passes a range check as 10.0.0.1 and connects to 8.0.0.1.
// matrix-appservice-bridge 12.0.1, its latest, takes ip-cidr ^3; ip-cidr 3.1.0
// takes ip-address ^7, and even ip-cidr 4.0.2 takes ^9. No parent release
// admits the fix, so package.json `overrides` puts ip-address ^10.7.4 under
// ip-cidr.
//
// ip-address 10 renamed bigInteger()/fromBigInteger() to bigInt()/fromBigInt()
// on native bigint, which every ip-cidr release still calls: under the
// override `new IPCIDR(...)` throws. The bridge constructs one in exactly one
// place, ProvisioningApi, which it only re-exports at load time and never
// builds itself; the tunnel has never used it. So the override removes the
// vulnerable parser and breaks only code nothing here runs.
//
// Each half is measured. If an ip-cidr release learns the new API the throw
// stops and that test says the override is now free. If the tunnel ever
// reaches for ProvisioningApi, the source check fails before the constructor
// would at startup, and says why.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fromCidr = (id) => require.resolve(id, { paths: [path.dirname(require.resolve("ip-cidr"))] });

// The advisory's first fixed release.
const FIXED = [10, 3, 1];

test("ip-cidr resolves a fixed ip-address, through package.json overrides", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  const pinned = pkg.overrides && pkg.overrides["ip-cidr"] && pkg.overrides["ip-cidr"]["ip-address"];
  assert.ok(pinned, "package.json overrides must pin ip-address under ip-cidr (GHSA-mwp4-54f8-5fhr)");
  const installed = JSON.parse(fs.readFileSync(fromCidr("ip-address/package.json"), "utf8")).version;
  const v = installed.split(".").map(Number);
  const fixed = v[0] !== FIXED[0] ? v[0] > FIXED[0] : v[1] !== FIXED[1] ? v[1] > FIXED[1] : v[2] >= FIXED[2];
  assert.ok(fixed, `ip-cidr resolves ip-address ${installed}, below ${FIXED.join(".")}; fix: npm install (the override says ${pinned})`);
  const { Address4 } = require(fromCidr("ip-address"));
  assert.throws(() => new Address4("010.0.0.1"), /leading zero/, "the fixed parser refuses a leading-zero octet");
});

test("the bridge library still loads with ip-cidr on the overridden ip-address", () => {
  const bridge = require("matrix-appservice-bridge");
  assert.equal(typeof bridge.Bridge, "function");
  assert.equal(typeof bridge.ProvisioningApi, "function", "provisioning is re-exported, so ip-cidr is required at load");
});

test("under the override ip-cidr cannot be constructed -- the cost the override accepts", () => {
  const IPCIDR = require("ip-cidr");
  assert.throws(() => new IPCIDR("10.0.0.0/8"), TypeError,
    "ip-cidr now constructs on ip-address 10: the override no longer breaks it; update this file's header");
});

test("the tunnel never uses ProvisioningApi, the one caller of ip-cidr", () => {
  const own = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
    .concat(fs.readdirSync(path.join(__dirname, "tools")).filter((f) => /\.(c|m)?js$/.test(f)).map((f) => path.join("tools", f)));
  const users = own.filter((f) => /ProvisioningApi/.test(fs.readFileSync(path.join(__dirname, f), "utf8")));
  assert.deepEqual(users, [],
    "ProvisioningApi constructs ip-cidr, which throws under the ip-address override; fix: drop the override only once an ip-cidr release takes ip-address >= 10.3.1");
});
