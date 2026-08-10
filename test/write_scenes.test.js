"use strict";
// `tmem write-scenes` — batch write N scenes from one JSON array on stdin, so a run
// with many scenes makes ONE tool-call instead of N heredoc write-scenes.
//   #1 writes N scenes in one call
//   #2 a reused name updates in place (no duplicate file)
//   #3 malformed input exits non-zero
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "scripts", "cli.js");
const { projectHashForCwd } = require("../scripts/memory_reader.js");

function tmpEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-ws-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-ws-proj-"));
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  return { home, proj };
}
function sceneDir(home, proj) {
  return path.join(home, ".memory-tencentdb", "projects", projectHashForCwd(proj), "scene_blocks");
}
function run(home, proj, input) {
  return execFileSync("node", [CLI, "write-scenes"], {
    encoding: "utf-8", input, env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: proj },
  });
}
const mdCount = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".md")).length : 0);

test("#1 write-scenes writes N scenes from one JSON array", () => {
  const { home, proj } = tmpEnv();
  const payload = JSON.stringify([
    { name: "One", summary: "first", heat: 5, body: "## Key Facts\n- a" },
    { name: "Two", summary: "second", heat: 3, body: "## Key Facts\n- b" },
    { name: "Three", summary: "third" },
  ]);
  const out = run(home, proj, payload);
  assert.match(out, /Wrote 3 scene/);
  assert.strictEqual(mdCount(sceneDir(home, proj)), 3);
});

test("#2 a reused scene name updates in place (no duplicate)", () => {
  const { home, proj } = tmpEnv();
  run(home, proj, JSON.stringify([{ name: "Dup", summary: "v1", body: "- one" }]));
  run(home, proj, JSON.stringify([{ name: "Dup", summary: "v2", body: "- two" }]));
  assert.strictEqual(mdCount(sceneDir(home, proj)), 1, "same name overwrites, not duplicates");
});

test("#3 malformed input exits non-zero", () => {
  const { home, proj } = tmpEnv();
  assert.throws(() => run(home, proj, "not json"), "bad JSON must fail");
  assert.throws(() => run(home, proj, "[]"), "empty array must fail");
  assert.throws(() => run(home, proj, JSON.stringify([{ summary: "no name" }])), "missing name must fail");
});

test("#4 a bad entry mid-array writes NOTHING (atomic validation)", () => {
  const { home, proj } = tmpEnv();
  const payload = JSON.stringify([
    { name: "Good", summary: "ok", body: "- a" },
    { summary: "no name here" },   // invalid — must abort the whole batch
  ]);
  assert.throws(() => run(home, proj, payload), "batch with a bad entry must fail");
  assert.strictEqual(mdCount(sceneDir(home, proj)), 0, "no scene written when any entry is invalid");
});
