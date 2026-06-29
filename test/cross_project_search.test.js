"use strict";
// Cross-project CLI: `tmem projects` lists every store, `tmem search --all` searches
// across all project stores (manual exploration), default search stays single-project.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "scripts", "cli.js");

function withFakeHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-xproj-home-"));
  try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function run(home, projectDir, args, input) {
  return execFileSync("node", [CLI, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: projectDir },
    input: input || "",
    encoding: "utf-8",
  });
}

function seed(home, projectDir, content) {
  // episodic atoms land in the project store (persona/instruction would go global)
  const atom = JSON.stringify([{ content, type: "episodic", priority: 50 }]);
  run(home, projectDir, ["write-l1"], atom);
}

test("search --all finds atoms across multiple project stores", () => {
  withFakeHome((home) => {
    seed(home, "/work/alpha", "alpha uses kafka for ingestion");
    seed(home, "/work/beta", "beta uses postgres skip-locked queue");

    // From alpha's cwd, default search must NOT see beta's atom...
    const dflt = run(home, "/work/alpha", ["search", "postgres"]);
    assert.ok(!/skip-locked/.test(dflt), "default search leaked another project");

    // ...but --all must surface it.
    const all = run(home, "/work/alpha", ["search", "postgres", "--all"]);
    assert.ok(/skip-locked/.test(all), "--all did not find beta's atom");
  });
});

test("search --all keeps the multi-word query intact (regression: dropped first token)", () => {
  withFakeHome((home) => {
    seed(home, "/work/alpha", "the quarterly architecture review doc");
    const out = run(home, "/work/alpha", ["search", "architecture review", "--all"]);
    assert.ok(/quarterly architecture review/.test(out), "multi-word query was mangled");
  });
});

test("projects lists every store with record counts", () => {
  withFakeHome((home) => {
    seed(home, "/work/alpha", "alpha note");
    seed(home, "/work/beta", "beta note");
    const out = run(home, "/work/alpha", ["projects"]);
    assert.ok(/-work-alpha/.test(out) && /-work-beta/.test(out), "projects missing a store");
    assert.ok(/\bstores\b/.test(out), "projects missing summary footer");
  });
});
