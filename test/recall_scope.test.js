"use strict";
// The automatic hook reads the PROJECT store only; a deliberate lookup still
// reads global too.
//
// WHY THIS IS PINNED. The hook fires on every prompt whether or not anyone wanted
// memory, so whatever it injects is a standing tax. The global store holds
// `instruction` and `persona` atoms — standing rules that already reach every
// turn through the tier-1 `<persona>` block, which reads persona.md. Retrieving
// them again as atoms bills the same content twice.
//
// Measured by replaying 60 real prompts (2026-08-03..09-03) against an unchanged
// store: global supplied 159 of 162 injected atoms before the relevance floor and
// 5 of 16 after it, while holding ZERO scene facts — so `<recalled-facts>` was
// already project-only by construction. After this change global supplies 0, and
// the project's own 11 semantic atoms are untouched.
//
// The CLI must NOT narrow: `tmem recall` is someone asking on purpose, and a
// cross-store answer is the point, the same reason `tmem search --all` exists.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { recallDirs, RECALL_SOURCE } = require("../scripts/memory_recall.js");
const { globalDir, projectDir } = require("../scripts/memory_writer.js");

const HASH = "-home-bd-projects-example";
const isGlobal = (d) => path.resolve(d) === path.resolve(globalDir());
const isProject = (d) => path.resolve(d) === path.resolve(projectDir(HASH));

test("hook recall reads the project store only", () => {
  const dirs = recallDirs(HASH, RECALL_SOURCE.HOOK);
  assert.equal(dirs.length, 1, `hook must read one store, got ${dirs.length}`);
  assert.ok(isProject(dirs[0]), "and it must be the project store");
  assert.ok(!dirs.some(isGlobal), "global standing rules arrive via <persona>, not as atoms");
});

test("a deliberate CLI lookup still reads global and project", () => {
  for (const source of [RECALL_SOURCE.CLI, RECALL_SOURCE.VIEW]) {
    const dirs = recallDirs(HASH, source);
    assert.equal(dirs.length, 2, `${source} must keep both stores`);
    assert.ok(dirs.some(isGlobal), `${source} must still read global`);
    assert.ok(dirs.some(isProject), `${source} must still read the project`);
  }
});

test("global order is preserved for the deliberate path", () => {
  // Project-before-global is a recall POLICY applied later (who drops first under
  // budget); the read order here is global-then-project and several callers merge
  // on it. Pin it so a refactor cannot silently reverse the merge inputs.
  const dirs = recallDirs(HASH, RECALL_SOURCE.CLI);
  assert.ok(isGlobal(dirs[0]), "global is read first");
  assert.ok(isProject(dirs[1]), "project second");
});

test("with no project there is nothing to narrow to, so the hook reads global", () => {
  // Scoping to a project that does not exist would mean scoping to nothing, which
  // would silently disable recall outside a project rather than narrowing it.
  const dirs = recallDirs("", RECALL_SOURCE.HOOK);
  assert.equal(dirs.length, 1);
  assert.ok(isGlobal(dirs[0]), "global is the only store available without a project");
});

test("an unknown source is treated as deliberate, not as the hook", () => {
  // Fail OPEN on an unrecognised caller: narrowing is a decision only the known
  // unattended path has earned, and a typo'd source must not silently halve what
  // some future caller can see.
  const dirs = recallDirs(HASH, "some-future-caller");
  assert.equal(dirs.length, 2);
  assert.ok(dirs.some(isGlobal));
});
