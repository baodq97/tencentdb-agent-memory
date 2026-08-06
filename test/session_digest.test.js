"use strict";
// The deterministic L0→digest transform: capture stores the user's prompt and
// discards the tool blocks where the machine-certain facts live (files edited,
// test pass/fail, git/release ops). digestSession recovers them with no LLM.

const { test } = require("node:test");
const assert = require("node:assert");
const { digestSession, toAtoms, toAtomRecords, classifyBash, digestAtomId } = require("../scripts/session_digest.js");

// A tiny synthetic transcript: one edit, one test run, one release.
const ENTRIES = [
  { type: "user", message: { content: "fix the sync bug" } },
  {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Editing the ranker." },
        { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/scripts/cli.js" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "node --test test/x.test.js" } },
      ],
    },
  },
  {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "t2", content: "# tests 372\n# pass 372\n# fail 0\n" },
      ],
    },
  },
  {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t3", name: "Bash", input: { command: "gh release create v0.7.8 --title x" } },
        { type: "tool_use", id: "t4", name: "Write", input: { file_path: "/repo/package.json" } },
      ],
    },
  },
];

test("digestSession recovers files, test pass/fail, and release from tool blocks", () => {
  const d = digestSession(ENTRIES);
  assert.deepStrictEqual(d.filesEdited.sort(), ["cli.js", "package.json"]);
  assert.deepStrictEqual(d.testRuns, ["tests: 372 pass, 0 fail"]);
  assert.deepStrictEqual(d.releases, ["0.7.8"]);
  assert.ok(d.gitOps.length === 0, "no git commit/pr in this fixture");
  // only the real prompt counts as a user turn; the tool_result carrier does not
  assert.strictEqual(d.userTurns, 1);
  assert.strictEqual(d.assistantTurns, 2);
});

test("classifyBash extracts release versions but ignores dependency-version noise", () => {
  // a plain bash command that merely PRINTS a dep version is not a release op
  assert.strictEqual(classifyBash("npm view left-pad version # 2.1.215", "2.1.215"), null);
  const rel = classifyBash("gh release create v0.7.7 --notes x", "");
  assert.strictEqual(rel.kind, "release");
  assert.strictEqual(rel.version, "0.7.7");
});

test("toAtoms turns a digest into outcome-bearing atoms, not a prompt echo", () => {
  const { isOutcomeBearing } = require("../scripts/memory_reachability.js");
  const d = digestSession(ENTRIES);
  const atoms = toAtoms(d, { intent: "fix the sync bug" });
  assert.ok(atoms.length >= 2, "should emit files + release + test atoms");
  // every emitted atom carries a concrete outcome (file/version/number), not a question
  for (const a of atoms) assert.ok(isOutcomeBearing(a), `atom should be outcome-bearing: ${a}`);
  assert.ok(atoms.some((a) => /released v0\.7\.8/.test(a)));
  assert.ok(atoms.some((a) => /cli\.js/.test(a)));
});

test("toAtomRecords carries a stable slot key so a re-digest updates in place (GAP-2)", () => {
  const d = digestSession(ENTRIES);
  const recs = toAtomRecords(d, { intent: "fix the sync bug" });
  const keys = recs.map((r) => r.key);
  assert.ok(keys.includes("files") && keys.includes("test") && keys.includes("release:0.7.8"));
  // identity is a pure function of (session, slot) — NOT of the body, so a changed
  // count ("40 files" → "42") keeps the same id and upserts instead of duplicating.
  assert.strictEqual(digestAtomId("S1", "files"), digestAtomId("S1", "files"));
  assert.notStrictEqual(digestAtomId("S1", "files"), digestAtomId("S2", "files"));
  assert.notStrictEqual(digestAtomId("S1", "files"), digestAtomId("S1", "test"));
  assert.match(digestAtomId("S1", "files"), /^digest-[0-9a-f]{16}$/);
});

test("toAtoms emits nothing for a turn with no tool activity", () => {
  const d = digestSession([{ type: "user", message: { content: "just a question?" } }]);
  assert.deepStrictEqual(toAtoms(d), []);
});

test("digestSession is safe on empty / malformed input", () => {
  const d = digestSession([]);
  assert.deepStrictEqual(d.filesEdited, []);
  assert.deepStrictEqual(d.events, []);
  assert.strictEqual(digestSession(null).turns, 0);
});
