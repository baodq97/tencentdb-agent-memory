"use strict";
// GAP-1 + GAP-2: the shared capture orchestration must write outcome-atoms once,
// then converge — a re-run of the same session writes nothing, and a session that
// GREW (one more file edited) updates the slot in place instead of duplicating.
// Runs against a real temp store so upsert/jsonl/identity are exercised together.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { captureDigest } = require("../scripts/digest_capture.js");
const { MemoryStore } = require("../scripts/memory_store.js");

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "digcap-"));
}

const ENTRIES = [
  { type: "assistant", message: { content: [
    { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/r/cli.js" } },
    { type: "tool_use", id: "b1", name: "Bash", input: { command: "gh release create v0.7.8" } },
    { type: "tool_use", id: "b2", name: "Bash", input: { command: "node --test test/x.js" } },
  ] } },
  { type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "b2", content: "ℹ pass 10\nℹ fail 0\n" },
  ] } },
];

test("captureDigest writes once, re-run is a no-op, growth updates in place (idempotent)", () => {
  const base = tmpBase();
  try {
    const r1 = captureDigest({ entries: ENTRIES, baseDir: base, sessionId: "S1", apply: true });
    assert.strictEqual(r1.written, 3);
    assert.strictEqual(r1.skipped, 0);

    // identical re-run: nothing new
    const r2 = captureDigest({ entries: ENTRIES, baseDir: base, sessionId: "S1", apply: true });
    assert.strictEqual(r2.written, 0);
    assert.strictEqual(r2.skipped, 3);

    // session grew by one edited file → the "files" slot body changes, same id
    const grown = JSON.parse(JSON.stringify(ENTRIES));
    grown[0].message.content.push({ type: "tool_use", id: "e2", name: "Write", input: { file_path: "/r/pkg.json" } });
    const r3 = captureDigest({ entries: grown, baseDir: base, sessionId: "S1", apply: true });
    assert.strictEqual(r3.written, 1);   // only the files slot
    assert.strictEqual(r3.skipped, 2);

    const store = new MemoryStore(path.join(base, "index.db"), { readOnly: true });
    assert.strictEqual(store.count(), 3, "still 3 rows — no duplicates");
    const contents = store.allRecords().map((r) => r.content);
    assert.ok(contents.some((c) => /edited 2 file\(s\).*pkg\.json/.test(c)), "files slot updated in place");
    assert.ok(contents.some((c) => /released v0\.7\.8/.test(c)));
    assert.ok(contents.some((c) => /10 pass, 0 fail/.test(c)));
    // digest atoms are semantic so recall's keepDistilledAtoms keeps them
    assert.ok(store.allRecords().every((r) => r.type === "semantic"));
    store.close();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("captureDigest dry-run computes atoms but writes nothing", () => {
  const base = tmpBase();
  try {
    const r = captureDigest({ entries: ENTRIES, baseDir: base, sessionId: "S1", apply: false });
    assert.strictEqual(r.written, 0);
    assert.ok(r.atoms.length >= 3);
    assert.ok(r.atoms.every((a) => a.id && a.key && a.content));
    assert.ok(!fs.existsSync(path.join(base, "index.db")), "no store created on dry-run");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
