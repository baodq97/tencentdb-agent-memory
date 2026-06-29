// test/memory_store.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { MemoryStore, toFtsQuery } = require("../scripts/memory_store.js");

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-store-"));
  const store = new MemoryStore(path.join(dir, "index.db"));
  return { store, dir };
}

function seed(store, id, content) {
  store.upsert({
    id, content, type: "persona", priority: 50, scene_name: "t",
    source_message_ids: [], metadata: {}, timestamps: ["2026-01-01T00:00:00Z"],
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    sessionKey: "t", sessionId: "t",
  });
}

test("recalls Vietnamese records by diacritic query", () => {
  const { store, dir } = tmpStore();
  try {
    seed(store, "vi1", "User prefers technical explanations in Vietnamese (giải thích bằng tiếng việt)");
    const hits = store.search("tiếng việt", 10).map((r) => r.record_id);
    assert.ok(hits.includes("vi1"), `expected "tiếng việt" to recall vi1, got [${hits}]`);

    const hits2 = store.search("giải thích", 10).map((r) => r.record_id);
    assert.ok(hits2.includes("vi1"), `expected "giải thích" to recall vi1, got [${hits2}]`);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("treats FTS5 operator words as literals, not operators (no query breakage)", () => {
  const { store, dir } = tmpStore();
  try {
    seed(store, "en1", "alpha beta gamma delta");
    // Must not throw and must not behave as a boolean operator
    assert.doesNotThrow(() => store.search("alpha AND beta OR NOT gamma NEAR delta", 10));
    const q = toFtsQuery("TypeScript AND Python");
    assert.match(q, /"AND"/, `operator word should be quoted as literal, got ${q}`);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
