"use strict";
/**
 * A PATH that always contains a `claude` binary, for tests that must get PAST
 * consolidate_runner's preflight.
 *
 * `findClaude` scans PATH for an executable named `claude`. Tests that stubbed
 * `spawnSyncFn` and then passed `env: { PATH: process.env.PATH }` were therefore
 * still reading a real machine fact: whether the developer has Claude Code
 * installed. On a machine that does, every such test passed; on one that does
 * not, the run short-circuits to `skipped/no-claude-binary` before ever reaching
 * the behaviour under test.
 *
 * That is not hypothetical. It shipped: 445 tests green locally, 7 failures on a
 * CI runner with no `claude` on PATH, which failed the release publish. Stubbing
 * the spawn is not enough — the LOOKUP has to be stubbed too, and the honest way
 * to stub a PATH lookup is to put a real file on a real PATH.
 *
 * The file is a no-op shell script and is never executed: every caller stubs
 * `spawnSyncFn`, so only its existence and mode are read. The directory comes
 * from mkdtempSync, so `--import ./test/_tmp_cleanup.js` removes it on exit.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let dir = null;

/** PATH with a directory containing an executable `claude` at the front. */
function pathWithClaude() {
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-fakebin-"));
    const bin = path.join(dir, "claude");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bin, 0o755);
  }
  return dir + path.delimiter + (process.env.PATH || "");
}

/** A full env for runConsolidation: the caller's overrides plus that PATH. */
function envWithClaude(extra) {
  return { ...(extra || {}), PATH: pathWithClaude() };
}

module.exports = { pathWithClaude, envWithClaude };
