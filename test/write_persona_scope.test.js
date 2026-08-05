"use strict";
// WS2c/hybrid — `write-persona --scope global|project` routes the doctrine to the
// right store. Global = cross-project traits; project = this repo's doctrine.
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "scripts", "cli.js");
const { projectHashForCwd } = require("../scripts/memory_reader.js");

function run(scopeArgs, home, projectDir, input) {
  return execFileSync("node", [CLI, "write-persona", ...scopeArgs], {
    input,
    encoding: "utf-8",
    env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: projectDir },
  });
}

function tmpEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-proj-"));
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true }); // make it a project root
  return { home, proj };
}

const CLEAN = `# User Persona

## Standing Instructions
- Always answer concisely, code-first.
- Always verify a claim against a primary source before writing.
`;

test("--scope project writes to the project store, not global", () => {
  const { home, proj } = tmpEnv();
  run(["--scope", "project"], home, proj, CLEAN);
  const hash = projectHashForCwd(proj);
  const projPersona = path.join(home, ".memory-tencentdb", "projects", hash, "persona.md");
  const globalPersona = path.join(home, ".memory-tencentdb", "global", "persona.md");
  assert.ok(fs.existsSync(projPersona), "project persona.md should exist");
  assert.ok(!fs.existsSync(globalPersona), "global persona.md must NOT be written");
  assert.match(fs.readFileSync(projPersona, "utf-8"), /Standing Instructions/);
});

test("default (no scope) writes to the global store", () => {
  const { home, proj } = tmpEnv();
  run([], home, proj, CLEAN);
  const globalPersona = path.join(home, ".memory-tencentdb", "global", "persona.md");
  assert.ok(fs.existsSync(globalPersona), "global persona.md should exist by default");
});

test("invalid scope is rejected (exit non-zero)", () => {
  const { home, proj } = tmpEnv();
  assert.throws(() => run(["--scope", "team"], home, proj, CLEAN));
});

test("persona --scope project reads back the project doctrine, not global", () => {
  const { home, proj } = tmpEnv();
  const DOCTRINE = "# Team Operating Doctrine\n\n## Agent Rules\n- Always run tests before pushing here.\n";
  run(["--scope", "project"], home, proj, DOCTRINE);
  const readProj = execFileSync("node", [CLI, "persona", "--scope", "project"], {
    encoding: "utf-8",
    env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: proj },
  });
  assert.match(readProj, /Operating Doctrine/);
  const readGlobal = execFileSync("node", [CLI, "persona"], {
    encoding: "utf-8",
    env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: proj },
  });
  assert.doesNotMatch(readGlobal, /Operating Doctrine/, "global persona must not show the project doctrine");
});
