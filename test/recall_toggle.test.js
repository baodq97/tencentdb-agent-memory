"use strict";
// Per-project recall toggle: `tmem config recall on|off` gates the UserPromptSubmit
// context injection for one project without touching ingest/consolidate. Additive +
// fail-open so existing stores (no flag) keep recall ON.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "scripts", "cli.js");
const HOOK = path.join(__dirname, "..", "hooks", "scripts", "on_user_prompt.js");
const PLUGIN_ROOT = path.join(__dirname, "..");

function withFakeHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-recall-home-"));
  try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function cli(home, projectDir, args, input) {
  return execFileSync("node", [CLI, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: projectDir },
    input: input || "",
    encoding: "utf-8",
  }).trim();
}

function runHook(home, cwd, prompt) {
  return execFileSync("node", [HOOK], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    input: JSON.stringify({ prompt, cwd }),
    encoding: "utf-8",
  }).trim();
}

test("recall defaults ON for a project with no stored flag (migration-safe)", () => {
  withFakeHome((home) => {
    assert.strictEqual(cli(home, "/work/alpha", ["config", "recall"]), "on");
  });
});

test("`config recall off` then `on` round-trips per project", () => {
  withFakeHome((home) => {
    assert.match(cli(home, "/work/alpha", ["config", "recall", "off"]), /off/);
    assert.strictEqual(cli(home, "/work/alpha", ["config", "recall"]), "off");
    assert.match(cli(home, "/work/alpha", ["config", "recall", "on"]), /on/);
    assert.strictEqual(cli(home, "/work/alpha", ["config", "recall"]), "on");
  });
});

test("the toggle is scoped to one project, not global", () => {
  withFakeHome((home) => {
    cli(home, "/work/alpha", ["config", "recall", "off"]);
    assert.strictEqual(cli(home, "/work/alpha", ["config", "recall"]), "off");
    assert.strictEqual(cli(home, "/work/beta", ["config", "recall"]), "on");
  });
});

test("UserPromptSubmit hook injects nothing when recall is off", () => {
  withFakeHome((home) => {
    cli(home, "/work/alpha", ["config", "recall", "off"]);
    const out = runHook(home, "/work/alpha", "what do you know about me");
    assert.strictEqual(out, "{}", "hook must emit empty object when recall disabled");
  });
});

test("invalid recall value is rejected", () => {
  withFakeHome((home) => {
    assert.throws(() => cli(home, "/work/alpha", ["config", "recall", "maybe"]));
  });
});
