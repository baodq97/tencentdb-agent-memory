// test/tmem_launcher.test.js
// The `tmem` launcher must always resolve the CORRECT plugin version at runtime,
// so a stale launcher copy can never run an outdated cli.js again.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { resolveCliPath, compareSemver } = require("../scripts/tmem.js");

function mkVersionDir(root, version) {
  const d = path.join(root, version, "scripts");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "cli.js"), "// stub cli\n");
  return path.join(d, "cli.js");
}

test("compareSemver orders versions numerically, not lexically", () => {
  const v = ["0.4.2", "0.10.0", "0.4.10", "0.2.3", "1.0.0"].sort(compareSemver);
  assert.deepStrictEqual(v, ["0.2.3", "0.4.2", "0.4.10", "0.10.0", "1.0.0"]);
});

test("prefers CLAUDE_PLUGIN_ROOT (the version Claude Code loaded)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-res-"));
  try {
    const pluginRoot = path.join(tmp, "loaded");
    fs.mkdirSync(path.join(pluginRoot, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "scripts", "cli.js"), "// loaded\n");
    const cache = path.join(tmp, "cache");
    mkVersionDir(cache, "9.9.9"); // newer exists, but pluginRoot wins
    const got = resolveCliPath({ pluginRoot, cacheDir: cache });
    assert.strictEqual(got, path.join(pluginRoot, "scripts", "cli.js"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("lone PATH shim (no sibling cli.js) falls back to the NEWEST installed version", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-res-"));
  try {
    const cache = path.join(tmp, "cache");
    mkVersionDir(cache, "0.2.3");
    mkVersionDir(cache, "0.4.2");
    const newest = mkVersionDir(cache, "0.10.0");
    // siblingDir models ~/.local/bin — the shim is a lone file, no cli.js next to it.
    const shimDir = path.join(tmp, "bin");
    fs.mkdirSync(shimDir, { recursive: true });
    const got = resolveCliPath({ pluginRoot: undefined, cacheDir: cache, siblingDir: shimDir });
    assert.strictEqual(got, newest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("npm-standalone sibling cli.js wins over an installed plugin cache", () => {
  // Regression: `npx @baodq97/tmem` on a machine that also has the plugin installed
  // MUST run its own sibling cli.js, not the (older/different) plugin-cache copy.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-res-"));
  try {
    const cache = path.join(tmp, "cache");
    mkVersionDir(cache, "0.7.0"); // plugin cache present and newer-looking
    const pkgDir = path.join(tmp, "node_modules", "@baodq97", "tmem", "scripts");
    fs.mkdirSync(pkgDir, { recursive: true });
    const sibling = path.join(pkgDir, "cli.js");
    fs.writeFileSync(sibling, "// npm cli\n");
    const got = resolveCliPath({ pluginRoot: undefined, cacheDir: cache, siblingDir: pkgDir });
    assert.strictEqual(got, sibling);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ignores non-version cache entries (.DS_Store, 'latest', partial installs)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-res-"));
  try {
    const cache = path.join(tmp, "cache");
    mkVersionDir(cache, "0.4.2");
    // junk that must NOT win the "newest" sort
    fs.mkdirSync(path.join(cache, "latest", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(cache, "latest", "scripts", "cli.js"), "// junk\n");
    fs.writeFileSync(path.join(cache, ".DS_Store"), "x");
    fs.mkdirSync(path.join(cache, "0.5.0"), { recursive: true }); // partial: no scripts/cli.js
    const shimDir = path.join(tmp, "bin"); // lone shim: no sibling cli.js → cache scan
    fs.mkdirSync(shimDir, { recursive: true });
    const got = resolveCliPath({ pluginRoot: undefined, cacheDir: cache, siblingDir: shimDir });
    assert.strictEqual(got, path.join(cache, "0.4.2", "scripts", "cli.js"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("launcher propagates the child cli exit code", () => {
  const { spawnSync } = require("node:child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-exit-"));
  try {
    const root = path.join(tmp, "root");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "cli.js"), "process.exit(7);\n");
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "tmem.js")], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
    });
    assert.strictEqual(r.status, 7);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("falls back to the sibling cli.js when no plugin root and no cache", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-res-"));
  try {
    const got = resolveCliPath({ pluginRoot: path.join(tmp, "nope"), cacheDir: path.join(tmp, "empty") });
    assert.strictEqual(got, path.join(__dirname, "..", "scripts", "cli.js"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("default siblingDir is the launcher's own directory", () => {
  // No overrides but a bogus pluginRoot + empty cache → the real sibling next to
  // scripts/tmem.js must resolve (proves siblingDir defaults to __dirname).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-res-"));
  try {
    const got = resolveCliPath({ pluginRoot: path.join(tmp, "nope"), cacheDir: path.join(tmp, "empty") });
    assert.strictEqual(got, path.join(__dirname, "..", "scripts", "cli.js"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
