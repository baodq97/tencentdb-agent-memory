"use strict";
// The write-side low-signal gate.
//
// 39.2% of the real store is low-signal, and the audit proved it is a WRITE bug:
// 96 copies of one `<task-notification>` in a single duplicate group, 370
// `Base directory for this skill:` echoes. These tests pin BOTH halves of the
// gate — what it refuses, and (louder) what it must never refuse. Every "accepted"
// case below is a VERBATIM record from the real corpus that a wider predicate
// would have destroyed.
//
// Isolation: every case runs autoCapture() in a child process with HOME pointed
// at a temp dir, so nothing here can touch ~/.memory-tencentdb.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CAPTURE = path.join(__dirname, "..", "scripts", "memory_auto_capture.js");

/**
 * Run one autoCapture() in a throwaway HOME and report what happened to the
 * store, not just what the function returned — "captured: false" and "nothing
 * was written" are different claims and the second is the one that matters.
 */
function capture(userText, { env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-gate-"));
  try {
    const proj = path.join(home, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const script = `
      const c = require(${JSON.stringify(CAPTURE)});
      const r = c.autoCapture({
        userText: JSON.parse(process.env.GATE_TEXT),
        assistantText: "ok",
        sessionId: "s1",
        cwd: ${JSON.stringify(proj)},
      });
      process.stdout.write(JSON.stringify(r));
    `;
    const out = execFileSync("node", ["-e", script], {
      env: { ...process.env, HOME: home, USERPROFILE: home, GATE_TEXT: JSON.stringify(userText), ...env },
      encoding: "utf-8",
    });
    const result = JSON.parse(out);

    const stores = path.join(home, ".memory-tencentdb", "projects");
    let rows = 0;
    let changelog = [];
    if (fs.existsSync(stores)) {
      for (const slug of fs.readdirSync(stores)) {
        const base = path.join(stores, slug);
        const db = path.join(base, "index.db");
        if (fs.existsSync(db)) {
          const { DatabaseSync } = require("node:sqlite");
          const h = new DatabaseSync(db);
          rows += h.prepare("SELECT COUNT(*) n FROM l1_records").get().n;
          h.close();
        }
        const log = path.join(base, "changelog.jsonl");
        if (fs.existsSync(log)) {
          changelog = fs.readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
        }
      }
    }
    return { result, rows, changelog };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const assertRejected = (text, cls) => {
  const { result, rows } = capture(text);
  assert.strictEqual(result.captured, false, `should not capture: ${text.slice(0, 40)}`);
  assert.deepStrictEqual(result.skipClasses, [cls]);
  assert.strictEqual(rows, 0, "nothing may reach the store");
};

const assertAccepted = (text) => {
  const { result, rows } = capture(text);
  assert.strictEqual(result.captured, true, `must capture genuine content: ${text.slice(0, 60)}`);
  assert.strictEqual(rows, 1);
};

/* ── what the gate refuses ─────────────────────────────────────────── */

test("rejects <task-notification> envelopes", () => {
  // The exact text behind the 96-copy duplicate group.
  assertRejected("<task-notification>\n<summary>verify loop failed</summary>\n</task-notification>", "taskNotification");
});

test("rejects skill-loading echoes, case-insensitively", () => {
  assertRejected("Base directory for this skill: /home/dev/.claude/skills/harness\n\n# Harness", "skillEcho");
  assertRejected("BASE DIRECTORY FOR THIS SKILL: /home/x/.claude/skills/foo\n\n# Foo", "skillEcho");
});

test("rejects content that trims to nothing", () => {
  // Reachable despite isSubstantive()'s length>=15 rule: whitespace has length.
  assertRejected("                    \n\n   ", "empty");
});

/* ── what the gate must NEVER refuse ───────────────────────────────── */

test("accepts ordinary prose", () => {
  assertAccepted("please refactor the recall budget so it stops truncating the persona mid-rule");
});

test("accepts a long paste — pasteDump is reported, never gated", () => {
  // 1,737 auto-capture records match pasteDump (>=495 chars). It is a statement
  // that truncate() fired, not that the content is junk: a pasted spec, stack
  // trace or log excerpt has exactly this shape. Gating it would be the largest
  // data loss in the store's history, decided by a character count.
  assertAccepted("Spec for the tiered persona projection. " + "The tier-0 preamble carries always-duty bullets. ".repeat(20));
});

test("accepts a message starting with '/' — the slashOrTag half that is user text", () => {
  // Verbatim from the corpus. Three of the four '/'-leading records that are not
  // already taskNotification are genuine questions like this one.
  assertAccepted("/v1/admin/providers => luồng này lưu vào đâu? có bị isolated theo tenant không?");
  assertAccepted("/v1/admin/connectors/import => sao không có schema gì ở openapi cả?");
});

test("accepts assent-opening directives — continuation is ~90% false positives as a delete rule", () => {
  // All verbatim corpus records. Each opens with an assent token and then says
  // something the store exists to remember.
  assertAccepted("ok push và tạo pr and merge main đi");
  assertAccepted("đồng ý, tôi muốn validate gate là strict nhất");
  assertAccepted("ok, tat network run test lai");
  assertAccepted("Continue with the remaining tasks");
});

/* ── observability ─────────────────────────────────────────────────── */

test("a skip is logged with the class that matched", () => {
  const { changelog } = capture("<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>");
  assert.strictEqual(changelog.length, 1, "the skip must be recorded, not silent");
  const e = changelog[0];
  assert.strictEqual(e.action, "skipped");
  assert.strictEqual(e.reason, "low-signal");
  assert.deepStrictEqual(e.classes, ["taskNotification"]);
  assert.match(e.content, /^<task-notification>/, "a preview must be kept so a wrong rule can be reviewed");
  assert.ok(e.timestamp, "entries are ordered by timestamp in `tmem changelog`");
});

test("a capture writes no skip entry", () => {
  const { changelog } = capture("please refactor the recall budget so it stops truncating");
  assert.deepStrictEqual(changelog.filter((e) => e.action === "skipped"), []);
});

/* ── the escape hatch ──────────────────────────────────────────────── */

test("MEMORY_NOISE_GATE=off disables the gate", () => {
  const { result, rows } = capture(
    "<task-notification>\n<summary>verify loop failed</summary>\n</task-notification>",
    { env: { MEMORY_NOISE_GATE: "off" } },
  );
  assert.strictEqual(result.captured, true);
  assert.strictEqual(rows, 1);
});

test("config noise_gate=false disables the gate, env outranks config", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-gate-cfg-"));
  try {
    const base = path.join(home, ".memory-tencentdb");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "config.json"), JSON.stringify({ noise_gate: false }));
    const run = (env) => JSON.parse(execFileSync("node", ["-e",
      `const c=require(${JSON.stringify(CAPTURE)});process.stdout.write(JSON.stringify({on:c.getNoiseGateEnabled()}))`,
    ], { env: { ...process.env, HOME: home, USERPROFILE: home, ...env }, encoding: "utf-8" }));

    assert.strictEqual(run({}).on, false, "persisted config must be honoured");
    assert.strictEqual(run({ MEMORY_NOISE_GATE: "1" }).on, true, "env must outrank config");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("the gate defaults ON with no config at all", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-gate-def-"));
  try {
    const out = execFileSync("node", ["-e",
      `const c=require(${JSON.stringify(CAPTURE)});process.stdout.write(String(c.getNoiseGateEnabled()))`,
    ], { env: { ...process.env, HOME: home, USERPROFILE: home, MEMORY_NOISE_GATE: "" }, encoding: "utf-8" });
    assert.strictEqual(out, "true");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("setNoiseGateEnabled persists on/off and rejects anything ambiguous", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-gate-set-"));
  try {
    const out = execFileSync("node", ["-e", `
      const c = require(${JSON.stringify(CAPTURE)});
      c.setNoiseGateEnabled("off");
      const after = c.loadConfig().noise_gate;
      let threw = false;
      try { c.setNoiseGateEnabled("maybe"); } catch { threw = true; }
      process.stdout.write(JSON.stringify({ after, threw }));
    `], { env: { ...process.env, HOME: home, USERPROFILE: home, MEMORY_NOISE_GATE: "" }, encoding: "utf-8" });
    assert.deepStrictEqual(JSON.parse(out), { after: false, threw: true });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

/* ── no second implementation ──────────────────────────────────────── */

test("gate classes are real contract classes", () => {
  const { NOISE_GATE_CLASSES } = require("../scripts/low_signal.js");
  const { LOW_SIGNAL_CLASSES } = require("../scripts/view/contract.js");
  for (const c of NOISE_GATE_CLASSES) {
    assert.ok(LOW_SIGNAL_CLASSES.includes(c), `${c} is not a contract low-signal class`);
  }
  // Gating these would destroy genuine user content — see low_signal.js for the
  // corpus evidence. If a future change wants one of them, it must delete this
  // assertion deliberately and re-run the false-positive hunt.
  for (const c of ["pasteDump", "slashOrTag", "continuation"]) {
    assert.ok(!NOISE_GATE_CLASSES.includes(c), `${c} matches genuine user content and must stay out of the write gate`);
  }
});

test("the classifier's output is pinned case by case, and the gate is its gated subset", () => {
  // This battery used to assert `transform.classifyLowSignal` equalled
  // `lowSignal.classifyLowSignal` over these same cases. transform.js now
  // RE-EXPORTS that exact function object, so every case compared a value to
  // itself and the loop could not fail — and function identity is already pinned
  // properly, once, in view_transform.test.js ("transform re-exports
  // low_signal.js, it does not re-implement it").
  //
  // The cases were worth keeping; the assertion was not. So they now pin what
  // the predicates ACTUALLY RETURN — which the identity version never did: it
  // would have passed just as happily if both sides returned []. Each row is
  // (content, all classes, gated classes), and the second column is the write
  // gate's decision: [] means "stored".
  const { classifyLowSignal, noiseClasses, NOISE_GATE_CLASSES } = require("../scripts/low_signal.js");
  const cases = [
    // gated
    ["<task-notification>\n<summary>verify loop failed</summary>\n</task-notification>",
      ["taskNotification", "slashOrTag"], ["taskNotification"]],
    ["Base directory for this skill: /home/dev/.claude/skills/harness", ["skillEcho"], ["skillEcho"]],
    ["BASE DIRECTORY FOR THIS SKILL: /x", ["skillEcho"], ["skillEcho"]],
    ["   ", ["empty"], ["empty"]],
    ["", ["empty"], ["empty"]],
    // classified but NOT gated — these are the classes that match genuine user
    // content, and the whole point is that the third column stays empty.
    ["/v1/admin/providers => luồng này lưu vào đâu?", ["slashOrTag"], []],
    ["<bash-stdout>installed claude integration hook</bash-stdout>", ["slashOrTag"], []],
    ["ok push và tạo pr and merge main đi", ["continuation"], []],
    ["đồng ý", ["continuation"], []],
    ["được rồi", ["continuation"], []],
    ["Go ahead thanks", ["continuation"], []],
    ["x".repeat(495), ["pasteDump"], []],
    // clean
    ["gonna refactor this", [], []],           // 'go' must not match inside a word
    ["x".repeat(494), [], []],                 // one byte under the pasteDump edge
    ["please refactor the recall budget", [], []],
    // non-strings reach this from real call sites; neither may throw
    [null, ["empty"], ["empty"]],
    [12345, [], []],
  ];
  for (const [content, all, gated] of cases) {
    const label = JSON.stringify(String(content).slice(0, 40));
    assert.deepStrictEqual(classifyLowSignal(content), all, `classes changed for ${label}`);
    assert.deepStrictEqual(noiseClasses(content), gated, `gate decision changed for ${label}`);
    for (const c of gated) {
      assert.ok(NOISE_GATE_CLASSES.includes(c), `${c} was gated but is not a gate class`);
    }
  }
});

/* ── partial deployments must degrade, not stop capturing ──────────────
 * This file is loaded by the Stop hook on every turn. A sibling module that is
 * missing (half-finished upgrade, partial install, a file lost in packaging) is
 * a reason to capture less well — never a reason to capture nothing.
 */

/** A throwaway copy of scripts/ with `missing` deleted, plus a temp HOME. */
function withScriptsMissing(missing, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tmem-partial-"));
  try {
    const scripts = path.join(root, "scripts");
    fs.cpSync(path.join(__dirname, "..", "scripts"), scripts, { recursive: true });
    for (const m of [].concat(missing)) fs.rmSync(path.join(scripts, m));
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    return fn({ capture: path.join(scripts, "memory_auto_capture.js"), home, root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const runIn = (capture, home, body) => JSON.parse(execFileSync("node", ["-e",
  `const c = require(${JSON.stringify(capture)}); ${body}`,
], { env: { ...process.env, HOME: home, USERPROFILE: home, MEMORY_PERSONA_MAX_TOKENS: "" }, encoding: "utf-8" }));

// The test that used to stand here regexed memory_auto_capture.js for
// `const FALLBACK = (\d+);` and compared it to DEFAULT_TIER0_MAX_TOKENS. It was
// pinning a hand-copied literal that only the degraded path could reach — and the
// literal is gone: both modules now read the number from scripts/constants.js, a
// leaf that requires nothing, so there is no second copy to drift and nothing for
// a source scrape to find. The test below is what survives it, and it is the
// stronger statement: it checks the OBSERVABLE budget through a real capture run
// with persona_projection.js deleted from the tree.

test("a missing persona_projection.js does not touch the budget, and capture continues", () => {
  const { DEFAULT_TIER0_MAX_TOKENS } = require("../scripts/persona_projection.js");
  withScriptsMissing("persona_projection.js", ({ capture, home, root }) => {
    const proj = path.join(root, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const out = runIn(capture, home, `
      const budget = c.getPersonaMaxTokens();
      const r = c.autoCapture({
        userText: "please refactor the recall budget so it stops truncating",
        assistantText: "ok", sessionId: "s1", cwd: ${JSON.stringify(proj)},
      });
      process.stdout.write(JSON.stringify({ budget, captured: r.captured }));
    `);
    assert.strictEqual(out.captured, true, "a missing sibling must not cost the turn");
    assert.strictEqual(out.budget, DEFAULT_TIER0_MAX_TOKENS, "and the budget stays sane");
  });
});

test("a missing memory_reader.js still captures — to global, never nowhere", () => {
  withScriptsMissing("memory_reader.js", ({ capture, home, root }) => {
    const proj = path.join(root, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const out = runIn(capture, home, `
      const r = c.autoCapture({
        userText: "please refactor the recall budget so it stops truncating",
        assistantText: "ok", sessionId: "s1", cwd: ${JSON.stringify(proj)},
      });
      process.stdout.write(JSON.stringify(r));
    `);
    assert.strictEqual(out.captured, true);
    // Without the reader there is no trustworthy project slug, and inventing one
    // would split a project's memories across two stores silently. Global is the
    // wrong shelf but a real one.
    const base = path.join(home, ".memory-tencentdb");
    assert.ok(fs.existsSync(path.join(base, "global", "index.db")), "the atom landed in global");
    assert.strictEqual(fs.existsSync(path.join(base, "projects")), false,
      "and no guessed project slug was invented");
  });
});
