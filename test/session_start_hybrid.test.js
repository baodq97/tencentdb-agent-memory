"use strict";
// WS2c — SessionStart injects TWO independent tier-0 blocks: the cross-project
// <persona-core> (global store) and this repo's <project-doctrine> (project
// store). Each is projected under its own budget; the project block appears only
// when the project store actually has a doctrine (no empty header).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HOOK = path.join(__dirname, "..", "hooks", "scripts", "on_session_start.js");
const { projectHashForCwd } = require("../scripts/memory_reader.js");

const GLOBAL_PERSONA = `# User Persona

## Standing Instructions
- Always answer concisely, code-first.
- Always verify a claim against a primary source before writing.
`;
const PROJECT_DOCTRINE = `# Team Operating Doctrine

## Agent Rules
- Always run the test suite before pushing in this repo.
- Always resolve merge conflicts against both HEAD and origin/main.
`;

function setup({ global, project }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-hy-"));
  const repo = path.join(home, "proj");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const base = path.join(home, ".memory-tencentdb");
  if (global) {
    fs.mkdirSync(path.join(base, "global"), { recursive: true });
    fs.writeFileSync(path.join(base, "global", "persona.md"), global);
  }
  if (project) {
    const hash = projectHashForCwd(repo);
    fs.mkdirSync(path.join(base, "projects", hash), { recursive: true });
    fs.writeFileSync(path.join(base, "projects", hash, "persona.md"), project);
  }
  return { home, repo };
}

function runHook(home, repo) {
  const out = execFileSync("node", [HOOK], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: repo },
    encoding: "utf-8",
  });
  return (JSON.parse(out || "{}").hookSpecificOutput?.additionalContext) || "";
}

test("both stores populated → both tier-0 blocks injected", () => {
  const { home, repo } = setup({ global: GLOBAL_PERSONA, project: PROJECT_DOCTRINE });
  try {
    const ctx = runHook(home, repo);
    assert.match(ctx, /<persona-core>/);
    assert.match(ctx, /<project-doctrine>/);
    // global first, doctrine second
    assert.ok(ctx.indexOf("<persona-core>") < ctx.indexOf("<project-doctrine>"));
    assert.match(ctx, /run the test suite before pushing/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("only global → persona-core, no empty project-doctrine header", () => {
  const { home, repo } = setup({ global: GLOBAL_PERSONA });
  try {
    const ctx = runHook(home, repo);
    assert.match(ctx, /<persona-core>/);
    assert.ok(!ctx.includes("<project-doctrine>"), "must not emit an empty doctrine block");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("only project doctrine → doctrine block, no persona-core", () => {
  const { home, repo } = setup({ project: PROJECT_DOCTRINE });
  try {
    const ctx = runHook(home, repo);
    assert.match(ctx, /<project-doctrine>/);
    assert.ok(!ctx.includes("<persona-core>"), "no global persona → no persona-core block");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
