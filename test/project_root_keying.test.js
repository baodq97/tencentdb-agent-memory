"use strict";
// Regression: a subdir or a linked worktree MUST key the same memory store as the
// repo root, otherwise recall fragments per-cwd (30 scenes were stranded across 47
// aiquinta fragment stores before this fix). Root cause: projectHashForCwd slugified
// the raw path with no project-root normalization.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");

const { projectHashForCwd, pathFromSlugProbe } = require("../scripts/memory_reader.js");

function tmpGitRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-root-"));
  execSync("git init -q && git commit -q --allow-empty -m init && git worktree add -q wt-feat", {
    cwd: base, shell: "/bin/bash",
  });
  fs.mkdirSync(path.join(base, "svc", "deep"), { recursive: true });
  return base;
}

test("subdir keys the same store as the repo root", () => {
  const base = tmpGitRepo();
  assert.strictEqual(
    projectHashForCwd(path.join(base, "svc", "deep")),
    projectHashForCwd(base),
  );
});

test("a linked worktree keys the same store as the main repo root", () => {
  const base = tmpGitRepo();
  assert.strictEqual(
    projectHashForCwd(path.join(base, "wt-feat")),
    projectHashForCwd(base),
  );
});

test("pathFromSlugProbe reverses a slug with dashed dir names via longest-match", () => {
  // dir literally named "my-app" — the slug `-..-my-app-sub` must resolve back to it,
  // NOT to a non-existent `.../my/app/sub`.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-probe-"));
  const real = path.join(root, "my-app", "sub");
  fs.mkdirSync(real, { recursive: true });
  const slug = path.resolve(real).replace(/:/g, "-").replace(/[\\/]/g, "-");
  assert.strictEqual(pathFromSlugProbe(slug), path.resolve(real));
  // a slug whose directory does not exist returns null (unresolved)
  assert.strictEqual(pathFromSlugProbe(slug + "-gone-xyz"), null);
});

test("non-git path falls back to a plain path slug (no crash)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-nogit-"));
  const expected = path.resolve(dir).replace(/:/g, "-").replace(/[\\/]/g, "-");
  assert.strictEqual(projectHashForCwd(dir), expected);
});
