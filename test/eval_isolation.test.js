// test/eval_isolation.test.js
// Regression: eval_runner Section 8 (auto-capture) must NOT touch the user's real
// memory store. It once wiped real ac_/auto-capture records because it ran against
// ~/.memory-tencentdb directly. The section must isolate itself (own temp HOME).
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { MemoryStore } = require("../scripts/memory_store.js");
const { projectHashForCwd } = require("../scripts/memory_reader.js");

const REPO = path.resolve(__dirname, "..");

test("eval Section 8 does not delete real auto-capture memories", () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "eval-iso-home-"));
  try {
    // Seed a sentinel real memory exactly like an auto-captured project atom.
    const ph = projectHashForCwd(REPO);
    const dbPath = path.join(fakeHome, ".memory-tencentdb", "projects", ph, "index.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const store = new MemoryStore(dbPath);
    store.upsert({
      id: "ac_1700000000000_deadbeef", content: "REAL user memory — must survive eval",
      type: "episodic", priority: 50, scene_name: "auto-capture",
      source_message_ids: [], metadata: {}, timestamps: ["2026-01-01T00:00:00.000Z"],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      sessionKey: "", sessionId: "",
    });
    store.close();

    // Run only Section 8 with the fake HOME.
    // Point both POSIX ($HOME) and Windows ($USERPROFILE) home lookups at fakeHome.
    execFileSync("node", [path.join(REPO, "scripts/eval_runner.js"), "--section", "8"], {
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      stdio: "ignore",
    });

    // The sentinel must still be there.
    const after = new MemoryStore(dbPath);
    const found = after.allRecords().some((r) => r.record_id === "ac_1700000000000_deadbeef");
    after.close();
    assert.ok(found, "real auto-capture record was deleted by eval Section 8");
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
