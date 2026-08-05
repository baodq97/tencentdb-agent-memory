"use strict";
// Pure update-status logic (no network) — cli.js `tmem update` feeds it the
// current version and npm's latest, and acts on updateAvailable.
const { test } = require("node:test");
const assert = require("node:assert");
const { cmpVersion, updateStatus } = require("../scripts/version_check.js");

test("cmpVersion orders numerically, not lexically", () => {
  assert.ok(cmpVersion("0.10.0", "0.4.2") > 0, "0.10.0 > 0.4.2");
  assert.ok(cmpVersion("0.7.1", "0.7.1") === 0);
  assert.ok(cmpVersion("0.7.0", "0.7.1") < 0);
});

test("updateAvailable only when latest is strictly greater", () => {
  assert.strictEqual(updateStatus("0.7.0", "0.7.1").updateAvailable, true);
  assert.strictEqual(updateStatus("0.7.1", "0.7.1").updateAvailable, false);
  assert.strictEqual(updateStatus("0.8.0", "0.7.1").updateAvailable, false, "local ahead of npm ⇒ no update");
});

test("a missing/unreachable latest is never reported as an update", () => {
  assert.deepStrictEqual(updateStatus("0.7.1", null), { current: "0.7.1", latest: null, updateAvailable: false });
  assert.deepStrictEqual(updateStatus("0.7.1", "unknown"), { current: "0.7.1", latest: null, updateAvailable: false });
});
