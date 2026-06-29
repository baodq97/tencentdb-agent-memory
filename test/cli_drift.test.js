// test/cli_drift.test.js
// cli.js should warn (on stderr, non-fatal) when it is running a different version
// than the plugin Claude Code actually loaded ($CLAUDE_PLUGIN_ROOT).
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const REPO = path.resolve(__dirname, "..");
const CLI = path.join(REPO, "scripts", "cli.js");
const OWN_VERSION = require("../package.json").version;

function runHelp(envOverrides) {
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_ROOT;
  Object.assign(env, envOverrides);
  const r = spawnSync("node", [CLI, "--help"], { env, encoding: "utf8" });
  return { stdout: r.stdout || "", stderr: r.stderr || "" };
}

function fakePluginRoot(version) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-drift-"));
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "tencentdb-agent-memory", version }));
  return d;
}

test("warns when loaded plugin version differs from running cli version", () => {
  const root = fakePluginRoot("9.9.9");
  try {
    const { stderr } = runHelp({ CLAUDE_PLUGIN_ROOT: root });
    assert.match(stderr, /9\.9\.9/, `expected drift warning mentioning loaded version, got: ${stderr}`);
    assert.match(stderr, new RegExp(OWN_VERSION.replace(/\./g, "\\.")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no warning when versions match", () => {
  const root = fakePluginRoot(OWN_VERSION);
  try {
    const { stderr } = runHelp({ CLAUDE_PLUGIN_ROOT: root });
    assert.doesNotMatch(stderr, /warning/i, `unexpected drift warning: ${stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no warning when CLAUDE_PLUGIN_ROOT is unset", () => {
  const { stderr } = runHelp({});
  assert.doesNotMatch(stderr, /warning/i);
});
