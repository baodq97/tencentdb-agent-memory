"use strict";
// Per-project consolidation counter (GAP-5 fix).
//
// The turn counter and consolidation trigger are per-project: one project
// accruing to its threshold must NOT drag another project due, and marking one
// consolidated must NOT reset another. Migration is lazy and additive — a legacy
// global-only capture_state must not make any project "due" on upgrade (no
// dispatch storm).
//
// Isolation: every case runs under a throwaway HOME so nothing touches the real
// ~/.memory-tencentdb.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { projectHashForCwd } = require("../scripts/memory_reader.js");

const LONG = "This is a substantive engineering message about architecture and design decisions";

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-ppc-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Require AFTER HOME is set; the module reads os.homedir() per call, so a fresh
  // require is not strictly needed, but we clear the cache to be safe.
  delete require.cache[require.resolve("../scripts/memory_auto_capture.js")];
  const cap = require("../scripts/memory_auto_capture.js");
  try {
    return fn(home, cap);
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    delete require.cache[require.resolve("../scripts/memory_auto_capture.js")];
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function projDir(home) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-ppc-proj-"));
  return p;
}

test("Bar 1: a project going due does NOT drag another project due", () => {
  withHome((home, cap) => {
    const A = projDir(home);
    const B = projDir(home);
    const hashA = projectHashForCwd(A);
    const hashB = projectHashForCwd(B);

    // One substantive turn in A. A fresh store's warmup threshold is 1, so A goes
    // due after its first turn; B has captured nothing.
    const r = cap.autoCapture({ userText: LONG, assistantText: "ok", sessionId: "s-a", cwd: A });
    assert.strictEqual(r.captured, true);

    assert.strictEqual(cap.status(hashA).consolidation_due, true, "A should be due");
    assert.strictEqual(cap.status(hashB).consolidation_due, false, "B must NOT be due");
    assert.strictEqual(cap.status(hashB).turns_since_consolidation, 0, "B counter untouched");
  });
});

test("Bar 1: markConsolidated(A) resets only A, leaves B alone", () => {
  withHome((home, cap) => {
    const A = projDir(home);
    const B = projDir(home);
    const hashA = projectHashForCwd(A);
    const hashB = projectHashForCwd(B);

    cap.autoCapture({ userText: LONG, assistantText: "ok", sessionId: "s-a", cwd: A });
    cap.autoCapture({ userText: LONG + " two", assistantText: "ok", sessionId: "s-b", cwd: B });

    cap.markConsolidated(hashA);

    assert.strictEqual(cap.status(hashA).consolidation_due, false, "A reset");
    assert.strictEqual(cap.status(hashA).turns_since_consolidation, 0, "A since=0");
    // B was captured once into a fresh store ⇒ due; A's mark must not have touched it.
    assert.strictEqual(cap.status(hashB).consolidation_due, true, "B still due independently");
    assert.ok(cap.status(hashB).turns_since_consolidation >= 1, "B counter intact");
  });
});

test("Bar 1: per-project counters advance independently", () => {
  withHome((home, cap) => {
    const A = projDir(home);
    const B = projDir(home);
    const hashA = projectHashForCwd(A);
    const hashB = projectHashForCwd(B);

    for (let i = 0; i < 3; i++) cap.autoCapture({ userText: `${LONG} ${i}`, assistantText: "ok", sessionId: "s-a", cwd: A });
    cap.autoCapture({ userText: `${LONG} b`, assistantText: "ok", sessionId: "s-b", cwd: B });

    assert.strictEqual(cap.status(hashA).total_turns, 3, "A counted 3");
    assert.strictEqual(cap.status(hashB).total_turns, 1, "B counted 1");
  });
});

test("Bar 5: legacy global-only capture_state makes NO project due (no storm)", () => {
  withHome((home, cap) => {
    const base = path.join(home, ".memory-tencentdb");
    fs.mkdirSync(base, { recursive: true });
    // Pre-upgrade shape: global counter + due flag, NO projects map.
    fs.writeFileSync(
      path.join(base, "capture_state.json"),
      JSON.stringify({ turn_count: 999, last_consolidation_turn: 0, consolidation_due: true, sessions: {} })
    );

    const P = projDir(home);
    const hashP = projectHashForCwd(P);
    // No project-slot exists yet ⇒ the project is not due despite the legacy flag.
    assert.strictEqual(cap.checkConsolidationDue(hashP), null, "no per-project due on upgrade");
    assert.strictEqual(cap.status(hashP).consolidation_due, false);
  });
});

test("Bar 5: an established store migrates in 'not due' (seeded to backlog)", () => {
  withHome((home, cap) => {
    const P = projDir(home);
    const hashP = projectHashForCwd(P);
    const projStore = path.join(home, ".memory-tencentdb", "projects", hashP);
    const { writeL1Record } = require("../scripts/memory_writer.js");
    // Seed a pre-existing backlog of atoms (simulates a store from before upgrade).
    for (let i = 0; i < 5; i++) {
      writeL1Record(projStore, {
        id: `seed_${i}`, content: `backlog atom ${i}`, type: "episodic", priority: 50,
        scene_name: "auto-capture", timestamps: [new Date().toISOString()],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }
    // First capture under the new code lazily seeds the slot to the backlog and is
    // NOT immediately due (graduated warmup, since=1 < steady threshold).
    const r = cap.autoCapture({ userText: LONG, assistantText: "ok", sessionId: "s", cwd: P });
    assert.strictEqual(r.captured, true);
    assert.strictEqual(r.consolidationDue, false, "established store must not be due after one turn");
    assert.strictEqual(cap.status(hashP).consolidation_due, false);
  });
});
