// test/launcher_selfheal.test.js
// SessionStart self-heal: keep ~/.local/bin/tmem pointing at the current launcher,
// but NEVER clobber a foreign file the user owns.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { ensureLauncherInstalled } = require("../scripts/tmem.js");

const SOURCE = path.join(__dirname, "..", "scripts", "tmem.js");
const sourceText = fs.readFileSync(SOURCE, "utf8");

function tmpBin() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tmem-heal-"));
}

test("installs the launcher when target is missing", () => {
  const dir = tmpBin();
  try {
    const r = ensureLauncherInstalled({ sourceFile: SOURCE, binDir: path.join(dir, "bin") });
    assert.strictEqual(r.action, "installed");
    assert.strictEqual(fs.readFileSync(r.target, "utf8"), sourceText);
    assert.ok(fs.statSync(r.target).mode & 0o100, "target should be executable");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("no-op when target is already the current launcher", () => {
  const dir = tmpBin();
  try {
    const binDir = path.join(dir, "bin");
    ensureLauncherInstalled({ sourceFile: SOURCE, binDir });
    const r = ensureLauncherInstalled({ sourceFile: SOURCE, binDir });
    assert.strictEqual(r.action, "skipped-current");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("updates a stale hardcoded shim of ours", () => {
  const dir = tmpBin();
  try {
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const target = path.join(binDir, "tmem");
    // old-style hardcoded shim that pointed at a versioned cache dir
    fs.writeFileSync(target, "#!/usr/bin/env bash\nexec node /home/x/.claude/plugins/cache/tencentdb-agent-memory/tencentdb-agent-memory/0.2.3/scripts/cli.js \"$@\"\n");
    const r = ensureLauncherInstalled({ sourceFile: SOURCE, binDir });
    assert.strictEqual(r.action, "updated");
    assert.strictEqual(fs.readFileSync(target, "utf8"), sourceText);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("NEVER overwrites a foreign tmem the user owns", () => {
  const dir = tmpBin();
  try {
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const target = path.join(binDir, "tmem");
    const foreign = "#!/usr/bin/env python3\nprint('some other tmem tool')\n";
    fs.writeFileSync(target, foreign);
    const r = ensureLauncherInstalled({ sourceFile: SOURCE, binDir });
    assert.strictEqual(r.action, "skipped-foreign");
    assert.strictEqual(fs.readFileSync(target, "utf8"), foreign, "foreign file must be untouched");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("never throws on unreadable source / bad bin dir", () => {
  const r = ensureLauncherInstalled({ sourceFile: "/nonexistent/tmem.js", binDir: "/nonexistent/bin" });
  assert.strictEqual(r.action, "error");
});
