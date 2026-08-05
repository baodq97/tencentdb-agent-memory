"use strict";
// WS3 — the PreToolUse hook surfaces a project-doctrine guardrail when the pending
// Bash command matches an anti-pattern; stays silent otherwise; never blocks.
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.join(__dirname, "..", "hooks", "scripts", "on_pre_tool.js");
const { projectHashForCwd } = require("../scripts/memory_reader.js");

const DOCTRINE = `# Team Operating Doctrine

## Boundaries & Anti-patterns
- Don't pkill a bound server (SIGTERM 144); kill the specific serve.js PID instead.

## Agent Rules
- Before push or PR in this repo, run gh auth switch to the baodq97 account.
`;

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-pt-"));
  const repo = path.join(home, "proj");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const hash = projectHashForCwd(repo);
  const dir = path.join(home, ".memory-tencentdb", "projects", hash);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "persona.md"), DOCTRINE);
  return { home, repo };
}

function runHook(home, payload) {
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf-8",
  });
  return JSON.parse(out || "{}");
}

test("pending pkill surfaces the SIGTERM guardrail", () => {
  const { home, repo } = setup();
  try {
    const out = runHook(home, { tool_name: "Bash", tool_input: { command: "pkill -f serve.js" }, cwd: repo });
    const ctx = out.hookSpecificOutput?.additionalContext || "";
    assert.match(ctx, /memory-guardrail/);
    assert.match(ctx, /SIGTERM/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("unrelated command stays silent (emits {})", () => {
  const { home, repo } = setup();
  try {
    const out = runHook(home, { tool_name: "Bash", tool_input: { command: "ls -la src" }, cwd: repo });
    assert.strictEqual(out.hookSpecificOutput, undefined);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("non-Bash tool is skipped", () => {
  const { home, repo } = setup();
  try {
    const out = runHook(home, { tool_name: "Read", tool_input: { file_path: "/etc/hosts" }, cwd: repo });
    assert.strictEqual(out.hookSpecificOutput, undefined);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
