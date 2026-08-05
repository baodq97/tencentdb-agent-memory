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

test("write-persona gate honors a lowered persona-max-tokens config", () => {
  const { home, proj } = tmpEnv();
  // Lower tier-0 to 200 tokens (~800 chars) — the same knob SessionStart reads.
  execFileSync("node", [CLI, "config", "persona-max-tokens", "200"], {
    env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: proj }, encoding: "utf-8",
  });
  // 12 short always-rules: ~1200 chars total — fits the 4800 default, overflows 800.
  const lines = ["# User Persona", "", "## Standing Instructions"];
  for (let i = 0; i < 12; i++) {
    lines.push(`- Always keep standing rule number ${i} short, operative, and clear for the agent to follow here.`);
  }
  const persona = lines.join("\n") + "\n";
  // Must REJECT under the lowered budget (before the fix the gate used 4800 and passed).
  assert.throws(() => run(["--scope", "global"], home, proj, persona));
});

test("secret in a GLOBAL persona is rejected; project doctrine is exempt", () => {
  const { home, proj } = tmpEnv();
  const secretPersona = `# User Persona

## Standing Instructions
- Always deploy via azure subscription 550e8400-e29b-41d4-a716-446655440000.
`;
  // global write with a subscription id → rejected (exit non-zero), nothing written
  assert.throws(() => run(["--scope", "global"], home, proj, secretPersona));
  const globalPersona = path.join(home, ".memory-tencentdb", "global", "persona.md");
  assert.ok(!fs.existsSync(globalPersona), "secret must not reach the global store");

  // same content to project scope → allowed (a repo may name its own infra)
  run(["--scope", "project"], home, proj, secretPersona);
  const hash = projectHashForCwd(proj);
  assert.ok(fs.existsSync(path.join(home, ".memory-tencentdb", "projects", hash, "persona.md")));

  // --force overrides the global gate
  run(["--scope", "global", "--force"], home, proj, secretPersona);
  assert.ok(fs.existsSync(globalPersona), "--force should write despite the secret");
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
