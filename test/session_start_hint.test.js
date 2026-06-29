"use strict";
// SessionStart hook surfaces a one-line hint when the current project has legacy
// cwd-keyed fragment stores — and stays silent (emits {}) when it doesn't. It must
// never auto-merge (that stays user-triggered via `tmem migrate-fragments`).

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HOOK = path.join(__dirname, "..", "hooks", "scripts", "on_session_start.js");
const rawSlug = (p) => path.resolve(p).replace(/:/g, "-").replace(/[\\/]/g, "-");

function runHook(home, projectDir) {
  const out = execFileSync("node", [HOOK], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: projectDir },
    encoding: "utf-8",
  });
  return JSON.parse(out || "{}");
}

test("hints when the current project has fragment stores", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-ss-home-"));
  try {
    const repo = path.join(home, "proj");
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const root = rawSlug(repo);
    // fabricate a legacy fragment store dir for a subdir of this repo
    fs.mkdirSync(path.join(home, ".memory-tencentdb", "projects", root + "-svc-gateway"), { recursive: true });

    const out = runHook(home, repo);
    assert.match(out.hookSpecificOutput?.additionalContext || "", /migrate-fragments/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("stays silent when there are no fragments", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-ss-home2-"));
  try {
    const repo = path.join(home, "proj");
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.mkdirSync(path.join(home, ".memory-tencentdb", "projects", rawSlug(repo)), { recursive: true });

    const out = runHook(home, repo);
    assert.strictEqual(out.hookSpecificOutput, undefined, "should not hint without fragments");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
