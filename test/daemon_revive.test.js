"use strict";
/**
 * WS10 — daemon robustness (embedding always-on).
 *
 * Proves the two reliability guarantees the resident embed daemon lacked:
 *   1. embedViaDaemonStatus REPORTS the FTS-only fallback reason instead of
 *      silently handing back a null vector as if recall were healthy.
 *   2. ensureDaemon actually REVIVES a dead daemon (stale/missing pidfile) and
 *      is idempotent when a live daemon already owns the address.
 *
 * The daemon holds a 328MB model, so these tests never start a real one — they
 * inject a fake spawn and point the client at bogus addresses.
 */
const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const client = require("../scripts/embed_client.js");
const { pidFileForDir } = require("../scripts/embed_daemon.js");

// A unique fake dir => unique pidfile/socket token, isolated from any real daemon.
function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tmem-revive-${tag}-`));
}
function bogusAddr() {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\tmem-nope-${process.pid}-${Date.now()}`
    : path.join(os.tmpdir(), `tmem-nope-${process.pid}-${Date.now()}.sock`);
}

test("embedViaDaemonStatus reports the FTS-only fallback reason when the daemon is down", async () => {
  // Nothing listens on this address: must resolve (not hang) and REPORT a reason.
  const r = await client.embedViaDaemonStatus("hello", {
    addr: bogusAddr(),
    timeoutMs: 300,
    autoRevive: false,
  });
  assert.strictEqual(r.vector, null, "no daemon => no vector");
  assert.strictEqual(typeof r.reason, "string");
  assert.ok(r.reason && r.reason !== "ready", `expected a fallback reason, got ${r.reason}`);
});

test("ensureDaemon revives when the pidfile is missing (spawns a daemon)", () => {
  const dir = tmpDir("missing");
  try { fs.unlinkSync(pidFileForDir(dir)); } catch {}
  let spawned = 0;
  const res = client.ensureDaemon({
    dir,
    force: true,
    spawnFn: () => { spawned++; return { unref() {} }; },
  });
  assert.strictEqual(spawned, 1, "missing pidfile must trigger a revive spawn");
  assert.strictEqual(res.spawned, true);
});

test("ensureDaemon revives when the pidfile is stale (dead pid)", () => {
  const dir = tmpDir("stale");
  fs.writeFileSync(pidFileForDir(dir), "2147483646"); // essentially guaranteed dead
  let spawned = 0;
  const res = client.ensureDaemon({
    dir,
    force: true,
    spawnFn: () => { spawned++; return { unref() {} }; },
  });
  assert.strictEqual(spawned, 1, "stale pidfile must trigger a revive spawn");
  assert.strictEqual(res.spawned, true);
});

test("ensureDaemon is idempotent: a live pid does NOT spawn a duplicate", () => {
  const dir = tmpDir("live");
  fs.writeFileSync(pidFileForDir(dir), String(process.pid)); // this test process is alive
  let spawned = 0;
  const res = client.ensureDaemon({
    dir,
    force: true,
    spawnFn: () => { spawned++; return { unref() {} }; },
  });
  assert.strictEqual(spawned, 0, "a live daemon pid must not be duplicated");
  assert.strictEqual(res.spawned, false);
});

test("ensureDaemon never throws even if spawn fails (fail-open)", () => {
  const dir = tmpDir("throw");
  try { fs.unlinkSync(pidFileForDir(dir)); } catch {}
  const res = client.ensureDaemon({
    dir,
    force: true,
    spawnFn: () => { throw new Error("boom"); },
  });
  assert.strictEqual(res.spawned, false);
});
