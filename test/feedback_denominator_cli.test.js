"use strict";
// test/feedback_denominator_cli.test.js
//
// Pins the CLI half of the denominator fix, which test/doctor_denominator.test.js
// deliberately does not reach.
//
// That file pins the LIBRARY (memory_reachability.js), the SNAPSHOT
// (view/transform.js) and the PLAN RENDERER (doctor.js). All three were correct
// while `tmem doctor` and `tmem feedback` still printed the old numbers, because
// the reachability and feedback sections of those two commands are rendered
// inline in cli.js, not through renderPlanText(). The result was one command
// printing BOTH the eligible-scoped percentage and the episodic-scoped one, six
// lines apart — worse than printing only the wrong one, because the two disagree
// and neither says which population it counted.
//
// The specific advice that made this load-bearing: `tmem feedback` labelled every
// cold atom a "prune candidate" over a denominator that included the ~5.6k records
// NON_RECALL_TYPES (scripts/constants.js) excludes from recall by design. Following
// it would delete the whole episodic capture layer to move a percentage that never
// measured recall.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "scripts", "cli.js");

function withFakeHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-fbdenom-home-"));
  try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function run(home, projectDir, args, input) {
  return execFileSync("node", [CLI, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: projectDir },
    input: input || "",
    encoding: "utf-8",
  });
}

/** Seed `n` atoms of one type. episodic/persona are NON_RECALL_TYPES. */
function seed(home, projectDir, type, n, label) {
  const atoms = Array.from({ length: n }, (_, i) => ({
    content: `${label} atom ${i} — long enough to be stored verbatim`,
    type,
    priority: 50,
  }));
  run(home, projectDir, ["write-l1"], JSON.stringify(atoms));
}

/**
 * A recall log with `turns` rows and no injections at all. Every atom is
 * therefore cold, which is the case that used to read "99% cold, prune them" —
 * the denominator is the entire assertion here, not the hot count.
 */
function writeRecallLog(home, turns) {
  const base = path.join(home, ".memory-tencentdb");
  fs.mkdirSync(base, { recursive: true });
  const rows = Array.from({ length: turns }, (_, i) => JSON.stringify({
    at: `2026-09-07T00:00:0${i % 10}.000Z`,
    source: "hook",
    query: `question ${i}`,
    injectedIds: [],
    injectedFactIds: [],
    droppedIds: [],
    chars: 0,
  }));
  fs.writeFileSync(path.join(base, "recall_log.jsonl"), rows.join("\n") + "\n");
}

test("tmem feedback --json denominates cold on the recall-eligible population only", () => {
  withFakeHome((home) => {
    const proj = "/work/denom";
    // 4 eligible (semantic), 9 ineligible (episodic). Chosen so the two possible
    // denominators cannot coincide: 4/4 cold is 100%, 13/13 cold is also 100% —
    // so the assertion is on the COUNTS, which differ (4 vs 13), not the pct.
    seed(home, proj, "semantic", 4, "eligible");
    seed(home, proj, "episodic", 9, "ineligible");
    writeRecallLog(home, 5);

    const out = JSON.parse(run(home, proj, ["feedback", "--json"]));

    assert.strictEqual(out.eligibleAtoms, 4, "eligible count must exclude episodic");
    assert.strictEqual(out.coldAtoms, 4, "cold must be counted within the eligible population");
    assert.strictEqual(out.ineligibleAtoms, 9, "ineligible atoms must be reported, not folded in");
    assert.strictEqual(out.hotAtoms, 0);
    // The regression this pins: coldAtoms used to be 13 (every record in the store).
    assert.notStrictEqual(out.coldAtoms, out.eligibleAtoms + out.ineligibleAtoms,
      "cold was denominated over every record again");
  });
});

test("tmem feedback text output never calls by-design-cold atoms prune candidates", () => {
  withFakeHome((home) => {
    const proj = "/work/denom-text";
    seed(home, proj, "semantic", 2, "eligible");
    seed(home, proj, "episodic", 7, "ineligible");
    writeRecallLog(home, 3);

    const out = run(home, proj, ["feedback"]);

    assert.match(out, /recallable store: 0 hot .* 2 cold .*prune candidates/,
      "the prune-candidate line must be scoped to recallable atoms");
    assert.match(out, /out of recall scope by design: 7 .*NOT prune candidates/,
      "the by-design population must be named and excluded from prune advice");
  });
});

test("tmem doctor reports one recall-health percentage, and labels the episodic ratio as capture quality", () => {
  withFakeHome((home) => {
    const proj = "/work/denom-doctor";
    seed(home, proj, "semantic", 3, "eligible");
    seed(home, proj, "episodic", 11, "ineligible");
    writeRecallLog(home, 4);

    const out = run(home, proj, ["doctor"]);

    // The header line is the recall-health number, over the eligible population.
    assert.match(out, /atoms that can be recalled: \d+\/3 \(\d+%\) recalled at least once/,
      "header must denominate on the 3 eligible atoms");
    assert.match(out, /captured but out of recall scope by design: 11 episodic atoms/);

    // The episodic outcome ratio may still be printed — it is a real capture
    // signal — but it must name its population so it cannot be read as recall
    // health. The bare `capture signal:` label is what made that misreading easy.
    assert.doesNotMatch(out, /capture signal:/,
      "the unlabelled `capture signal:` line is what read as a recall metric");
    if (/carry an outcome/.test(out)) {
      assert.match(out, /capture quality \(episodic — not recallable by design\)/,
        "the episodic ratio must name its population");
    }
  });
});
