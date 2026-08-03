// test/persona_projection.test.js
//
// scripts/persona_projection.js is the SHARED node: the recall hot path and the
// memory visualiser both render from it, so a regression here is a regression
// everywhere. These tests are pure — the module takes text in and returns a
// projection out, so nothing here touches the filesystem and in particular
// nothing touches ~/.memory-tencentdb (see eval_isolation.test.js for why that
// rule exists: an earlier test destroyed the user's real memories).
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");

const P = require("../scripts/persona_projection.js");
const {
  parsePersona,
  classifyDuty,
  annotate,
  dutyCounts,
  prefersCore,
  coreSection,
  projectTier0,
  projectTier1,
  projectPersona,
  legacyProjection,
  truncateAtWord,
  MIN_BULLET_CHARS,
  LEGACY_MAX_CHARS,
} = P;

// ── Fixtures (inline; never read from disk) ─────────────────────────────────

const PERSONA = `# User Persona

## Identity
- Dev Aster, staff engineer, Hanoi.
- Repo github.com/example/thing, branch main, Node v24.1.0.

## Preferences
- Prefers Vietnamese in chat and English in every committed artifact.
- Concise and direct answers; no filler, no restating the question.
- Prefers pytest over unittest for new Python test suites.

## Working Style
- Reviews diffs bottom-up, reading the tests before the implementation.
- When he pushes back on a design, restate the tradeoff in one line.

## Standing Instructions
- No AI attribution trailers in commits. All committed artifacts English; VI in chat only.
- Never force-push a shared branch.
- KG foundation: never invent edges that the source does not state.
- When verifying a claim, run the command and paste the real output.
- Before any database migration, take a snapshot first.

## Environment
- Workstation at /home/dev/projects, CUDA 12.6, 64 GB RAM.
`;

const SECTIONS = parsePersona(PERSONA);

/** Rendered "- " lines of a projection, without the bullet marker. */
const renderedLines = (proj) =>
  proj.text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));

const boldMarkers = (s) => (s.match(/\*\*/g) || []).length;

// Every constant these tests reason about is IMPORTED, never re-declared. A local
// copy silently decouples: changing the value in the module then fails no test,
// which is precisely the coupling this file exists to catch. (It happened twice —
// a hardcoded 1200 budget, and a local MIN_KEPT_RATIO whose "mirrors an
// unexported constant" comment made the copy look deliberate and kept it alive
// through a sweep. Neither constant was unexported.) Literals below are only ever
// values a test passes in deliberately to exercise a behaviour.
test("constants: the char budget is derived from the token budget, not duplicated", () => {
  // Tokens are the primitive — tier 0 is the only budget the user sets in tokens
  // (`tmem persona-max-tokens`), so deriving chars from tokens keeps the round
  // trip exact instead of Math.floor-lossy for budgets not divisible by 4.
  assert.strictEqual(P.DEFAULT_TIER0_MAX_CHARS, P.DEFAULT_TIER0_MAX_TOKENS * P.CHARS_PER_TOKEN);
  assert.ok(P.CHARS_PER_TOKEN > 0 && Number.isFinite(P.DEFAULT_TIER0_MAX_TOKENS));
  assert.ok(P.DEFAULT_BULLET_MAX_CHARS > MIN_BULLET_CHARS);
});

// ───────────────────────────────────────────────────────────────────────────
// Parsing robustness
// ───────────────────────────────────────────────────────────────────────────

test("parsePersona: empty / null / whitespace input yields no sections, never throws", () => {
  assert.deepStrictEqual(parsePersona(""), []);
  assert.deepStrictEqual(parsePersona(null), []);
  assert.deepStrictEqual(parsePersona(undefined), []);
  assert.deepStrictEqual(parsePersona("   \n\n  \n"), []);
});

test("parsePersona: no ## headings at all — content lands in the unnamed section, nothing dropped", () => {
  const secs = parsePersona("just prose\nmore prose");
  assert.strictEqual(secs.length, 1);
  assert.strictEqual(secs[0].name, "");
  assert.deepStrictEqual(secs[0].bullets.map((b) => b.text), ["just prose", "more prose"]);
});

test("parsePersona: prose before the first heading is kept in the unnamed section", () => {
  const secs = parsePersona("# Title\nintro prose\n## A\n- one\n");
  assert.deepStrictEqual(secs.map((s) => s.name), ["", "A"]);
  assert.deepStrictEqual(secs[0].bullets.map((b) => b.text), ["intro prose"]);
  assert.deepStrictEqual(secs[1].bullets.map((b) => b.text), ["one"]);
});

test("parsePersona: a single # is the document title, not a section", () => {
  const secs = parsePersona("# User Persona\n## Identity\n- a\n");
  assert.deepStrictEqual(secs.map((s) => s.name), ["Identity"]);
});

test("parsePersona: CRLF is normalised", () => {
  const crlf = parsePersona("## A\r\n- one\r\n- two\r\n");
  const lf = parsePersona("## A\n- one\n- two\n");
  assert.deepStrictEqual(crlf, lf);
  assert.deepStrictEqual(crlf[0].bullets.map((b) => b.text), ["one", "two"]);
});

test("parsePersona: -, * and + all count as bullet markers", () => {
  const secs = parsePersona("## A\n- dash\n* star\n+ plus\n");
  assert.deepStrictEqual(secs[0].bullets.map((b) => b.text), ["dash", "star", "plus"]);
});

test("parsePersona: indented continuation lines join the preceding bullet", () => {
  const secs = parsePersona("## A\n- first line\n  continued here\n    and here\n- second\n");
  assert.deepStrictEqual(secs[0].bullets.map((b) => b.text), [
    "first line continued here and here",
    "second",
  ]);
  assert.strictEqual(secs[0].bullets[0].chars, "first line continued here and here".length);
  assert.deepStrictEqual(secs[0].bullets.map((b) => b.index), [0, 1]);
});

test("parsePersona: lineNo is 1-based and points at the line the bullet's `- ` opens on", () => {
  //          1          2  3      4        5        6       7          8  9      10           11
  const doc = "# Title\n\n## A\n- one\n- two\n  cont\n- three\n\n## B\nprose here\n- four\n";
  const secs = parsePersona(doc);
  const lines = doc.split("\n");
  for (const s of secs) {
    for (const b of s.bullets) {
      assert.ok(Number.isInteger(b.lineNo) && b.lineNo >= 1, `bad lineNo ${b.lineNo}`);
      // The named line must be where this bullet STARTS, not where it ends: a
      // continuation line must not move it forward.
      const opener = lines[b.lineNo - 1];
      assert.ok(
        opener.startsWith("- ") || opener === b.text,
        `lineNo ${b.lineNo} does not open bullet ${JSON.stringify(b.text)}: ${JSON.stringify(opener)}`
      );
    }
  }
  assert.deepStrictEqual(
    secs.map((s) => s.bullets.map((b) => [b.text, b.lineNo])),
    [
      [["one", 4], ["two cont", 5], ["three", 7]],
      [["prose here", 10], ["four", 11]],
    ]
  );
});

test("parsePersona: lineNo is identical across LF, CRLF and lone-CR input", () => {
  // Line numbering must survive newline normalisation — a visualiser that jumps
  // to a source line would be off by the number of \r\n pairs otherwise.
  const lf = parsePersona("## A\n- one\n- two\n");
  assert.deepStrictEqual(parsePersona("## A\r\n- one\r\n- two\r\n"), lf);
  assert.deepStrictEqual(parsePersona("## A\r- one\r- two\r"), lf);
  assert.deepStrictEqual(lf[0].bullets.map((b) => b.lineNo), [2, 3]);
});

test("parsePersona: real fixture keeps every section and bullet count", () => {
  assert.deepStrictEqual(
    SECTIONS.map((s) => [s.name, s.bullets.length]),
    [["Identity", 2], ["Preferences", 3], ["Working Style", 2], ["Standing Instructions", 5], ["Environment", 1]]
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Duty classification — the highest-value tests
// ───────────────────────────────────────────────────────────────────────────

test("classifyDuty REGRESSION: a bare 'No …' standing rule is ALWAYS, not conditional", () => {
  // A previous version read never/always/must/no as *trigger* words, which
  // inverted the whole design: a universal rule got silently gated behind the
  // prompt happening to mention "commits", so AI attribution trailers came back
  // on every other turn. Pin the corrected reading.
  assert.strictEqual(
    classifyDuty(
      "No AI attribution trailers in commits. All committed artifacts English; VI in chat only.",
      "Standing Instructions"
    ),
    "always"
  );
});

test("classifyDuty: never / always / must / no with no leading situation are ALWAYS", () => {
  const s = "Standing Instructions";
  assert.strictEqual(classifyDuty("Never force-push a shared branch.", s), "always");
  assert.strictEqual(classifyDuty("Always answer in the user's own language.", s), "always");
  assert.strictEqual(classifyDuty("Must run the full test suite.", s), "always");
  assert.strictEqual(classifyDuty("No secrets in committed files.", s), "always");
});

test("classifyDuty: a LEADING situational connective demotes to conditional", () => {
  const s = "Standing Instructions";
  for (const text of [
    "When verifying a claim, run the command and paste the real output.",
    "Whenever the build breaks, bisect before guessing.",
    "If the migration fails, roll back immediately.",
    "Before any database migration, take a snapshot first.",
    "After a merge lands, rerun the full suite.",
    "While debugging a flaky test, keep the raw log open.",
    "During a release freeze, only ship hotfixes.",
  ]) {
    assert.strictEqual(classifyDuty(text, s), "conditional", text);
  }
});

test("classifyDuty: Vietnamese leading triggers (khi / nếu) demote to conditional", () => {
  const s = "Standing Instructions";
  assert.strictEqual(classifyDuty("Khi người dùng hỏi lại, trả lời ngắn gọn.", s), "conditional");
  assert.strictEqual(classifyDuty("Nếu có lỗi build, dừng lại và báo cáo.", s), "conditional");
});

test("classifyDuty: a gerund opener is a situational clause", () => {
  assert.strictEqual(
    classifyDuty("Debugging config issues starts from the resolved path, not the docs.", "Standing Instructions"),
    "conditional"
  );
});

test("classifyDuty: 'default posture' / 'by default' is ALWAYS", () => {
  const s = "Standing Instructions";
  assert.strictEqual(classifyDuty("Default posture is to ask questions early.", s), "always");
  assert.strictEqual(classifyDuty("Ask clarifying questions by default when scope is unclear.", s), "always");
});

// ── Precedence: leading intent beats a trailing scope phrase ────────────────
//
// THE INVARIANT, for whoever next touches these regexes:
//
//   Only a situation that LEADS the rule makes it situational. A scope phrase
//   appearing LATER is qualification, not a gate.
//
// "Read each folder AGENTS.md before editing." is a universal rule with a note
// about when it bites; it is not a rule that only exists while you are editing.
// Demoting it to tier 1 hides it behind a keyword match, so it silently stops
// firing on the turns that do not happen to say "editing".
//
// Regression: SITUATION_SCOPE_RE used to be checked before DEFAULT_POSTURE_RE,
// UNCONDITIONAL_OPENERS and UNIVERSAL_RE, so any "before a …" / "before …ing"
// anywhere in the first clause outranked the bullet's own leading intent.

test("classifyDuty REGRESSION: a leading 'default posture' beats a later scope phrase", () => {
  assert.strictEqual(
    classifyDuty("Default posture is to ask before a large refactor.", "Standing Instructions"),
    "always"
  );
});

test("classifyDuty REGRESSION: a trailing scope phrase does not beat a leading universal", () => {
  const s = "Standing Instructions";
  // Bare form and scoped form must agree — the trailing clause is qualification.
  assert.strictEqual(classifyDuty("Read each folder AGENTS.md.", s), "always");
  assert.strictEqual(classifyDuty("Read each folder AGENTS.md before editing.", s), "always");
  assert.strictEqual(classifyDuty("Expand every acronym on first use.", s), "always");
});

test("classifyDuty REGRESSION: a trailing scope phrase does not beat a leading deontic", () => {
  const s = "Standing Instructions";
  assert.strictEqual(classifyDuty("Must run the full test suite.", s), "always");
  assert.strictEqual(classifyDuty("Must verify before claiming done.", s), "always");
  assert.strictEqual(classifyDuty("Never merge before the suite is green.", s), "always");
});

test("classifyDuty: the precedence fix does not over-correct — scoped rules stay conditional", () => {
  // Counter-cases. None of these has a leading universal or deontic, so the
  // situation really is the gate and they must stay on the per-turn channel.
  const s = "Standing Instructions";
  assert.strictEqual(
    classifyDuty("grep old symbol name before any rename; run uv run pytest after.", s),
    "conditional"
  );
  assert.strictEqual(classifyDuty("When verifying Azure facts, use microsoft-learn.", s), "conditional");
  assert.strictEqual(
    classifyDuty("KG foundation: never hand-read the YAML before a merge.", s),
    "conditional",
    "a bare noun-phrase domain label still scopes the rule to its domain"
  );
  // And the plain leading-situation cases are untouched.
  assert.strictEqual(classifyDuty("Before any database migration, take a snapshot first.", s), "conditional");
  assert.strictEqual(
    classifyDuty("Debugging config issues starts from the resolved path, not the docs.", s),
    "conditional"
  );
});

test("classifyDuty: a bare noun-phrase domain label is CONDITIONAL even worded with 'never'", () => {
  // The label scopes the rule to a domain, so it only fires inside that domain.
  const s = "Standing Instructions";
  assert.strictEqual(
    classifyDuty("KG foundation: never invent edges that the source does not state.", s),
    "conditional"
  );
  assert.strictEqual(
    classifyDuty("Technical-review deliverables: never ship without a risk table.", s),
    "conditional"
  );
});

test("classifyDuty: a label that asserts a universal CLAUSE stays ALWAYS", () => {
  // "An invoked skill is a GATE" is a fact about the world; the "when …" that
  // follows is elaboration, not a gate.
  assert.strictEqual(
    classifyDuty("**An invoked skill is a GATE**: when it runs it must complete.", "Standing Instructions"),
    "always"
  );
});

test("classifyDuty: the **Label**: prefix is stripped before the leading-trigger test", () => {
  // Without stripLabel(), the trigger sits mid-string and ZERO demotions fire —
  // real bullets are overwhelmingly written as `**Label**: body`.
  const s = "Standing Instructions";
  const labelled = "**Commit hygiene**: when committing a change, squash the noise commits.";
  const bare = "when committing a change, squash the noise commits.";
  assert.strictEqual(classifyDuty(bare, s), "conditional");
  assert.strictEqual(classifyDuty(labelled, s), "conditional", "label prefix must not hide the trigger");

  // Same strip runs under an `always`-prior section.
  assert.strictEqual(
    classifyDuty("**Review habit**: when he pushes back, restate the tradeoff.", "Preferences"),
    "conditional"
  );
});

test("classifyDuty: universal quantification with no domain label is ALWAYS", () => {
  const s = "Standing Instructions";
  assert.strictEqual(classifyDuty("Read each folder AGENTS.md.", s), "always");
  assert.strictEqual(classifyDuty("Expand every acronym on first use.", s), "always");
});

test("classifyDuty: unknown / ambiguous input fails safe to REFERENCE", () => {
  // Misclassifying INTO tier 0 pollutes every session forever; misclassifying
  // OUT of it merely reproduces today's behaviour. So the fail-safe is down.
  assert.strictEqual(classifyDuty("Some random noise phrase here", "Miscellaneous"), "reference");
  assert.strictEqual(classifyDuty("", "Preferences"), "reference");
  assert.strictEqual(classifyDuty(null, "Preferences"), "reference");
  assert.strictEqual(classifyDuty("   ", "Standing Instructions"), "reference");
  assert.strictEqual(classifyDuty("Dev Aster, staff engineer, Hanoi.", "Identity"), "reference");
});

test("classifyDuty: reference payload outweighs an 'always'-prior heading", () => {
  // An inventory item filed under Preferences is still an inventory item.
  assert.strictEqual(
    classifyDuty("Repo at /home/dev/projects, github branch main, Node v24.1.0", "Preferences"),
    "reference"
  );
});

test("classifyDuty: language/register is promoted out of a reference section", () => {
  // Which language to answer in governs EVERY turn — the single most visible
  // persona failure — so it is always-class wherever the author filed it.
  assert.strictEqual(
    classifyDuty("Always answer in Vietnamese, never in English.", "Identity"),
    "always"
  );
});

test("annotate is non-mutating and dutyCounts matches the annotation", () => {
  const before = JSON.stringify(SECTIONS);
  const ann = annotate(SECTIONS);
  assert.strictEqual(JSON.stringify(SECTIONS), before, "annotate must not mutate its input");
  for (const s of ann) for (const b of s.bullets) {
    assert.ok(["always", "conditional", "reference"].includes(b.duty), b.duty);
  }
  const counts = dutyCounts(SECTIONS);
  const total = counts.always + counts.conditional + counts.reference;
  assert.strictEqual(total, ann.reduce((n, s) => n + s.bullets.length, 0));
  assert.deepStrictEqual(counts, { always: 6, conditional: 4, reference: 3 });
});

// ───────────────────────────────────────────────────────────────────────────
// Tier 0: session preamble
// ───────────────────────────────────────────────────────────────────────────

test("tier0: EVERY section holding always-content is represented, not just the first", () => {
  const t0 = projectTier0(SECTIONS);
  const names = [...new Set(t0.bullets.map((b) => b.sectionName))];
  assert.deepStrictEqual(names, ["Preferences", "Working Style", "Standing Instructions"]);
  for (const n of names) assert.ok(t0.text.includes(`## ${n}`), `missing header for ${n}`);
  // Sections with no always-content contribute neither header nor lines.
  assert.ok(!t0.text.includes("## Identity"));
  assert.ok(!t0.text.includes("## Environment"));
});

test("tier0: a single large section cannot monopolise the budget (round-robin)", () => {
  const hog = Array.from(
    { length: 12 },
    (_, i) => `- Never skip step ${i} of the release checklist because the auditors will ask about it later.`
  ).join("\n");
  const secs = parsePersona(
    `## Preferences\n- Prefers Vietnamese in chat and English in every committed artifact.\n- Concise and direct answers everywhere.\n\n` +
      `## Standing Instructions\n${hog}\n\n` +
      `## Working Style\n- Reviews diffs bottom-up, always reading the tests before the implementation.\n`
  );
  const t0 = projectTier0(secs, { maxChars: 400 });
  const names = [...new Set(t0.bullets.map((b) => b.sectionName))];
  assert.deepStrictEqual(
    names.sort(),
    ["Preferences", "Standing Instructions", "Working Style"],
    "the 12-bullet section starved the others"
  );
  const hogged = t0.bullets.filter((b) => b.sectionName === "Standing Instructions").length;
  assert.ok(hogged < 12 && hogged >= 1, `hog section took ${hogged} bullets`);
});

test("tier0: usedChars never exceeds budgetChars and matches text length", () => {
  // Top of the sweep tracks the default so the default budget stays covered.
  for (const maxChars of [P.DEFAULT_TIER0_MAX_CHARS, 1200, 600, 300, 200, 120, 60, 1, 0]) {
    const t0 = projectTier0(SECTIONS, { maxChars });
    assert.strictEqual(t0.budgetChars, maxChars);
    assert.strictEqual(t0.usedChars, t0.text.length);
    assert.ok(t0.usedChars <= maxChars, `used ${t0.usedChars} > budget ${maxChars}`);
  }
});

test("tier1: truncation lands on a word boundary and marks truncated:true", () => {
  // Re-aimed from tier 0, which no longer truncates at all. Tier 1 is now the
  // ONLY place truncateAtWord runs in anger, so this is the only place the
  // word-boundary contract can still be observed end-to-end.
  const t1 = projectTier1(SECTIONS, { query: "database migration", bulletMaxChars: 70 });
  const cut = t1.bullets.filter((b) => b.truncated);
  assert.ok(cut.length > 0, "fixture must actually truncate, or this test proves nothing");
  for (const b of cut) {
    assert.ok(b.injectedChars < b.sourceChars, "truncated bullet must be shorter than its source");
  }
  for (const line of renderedLines(t1)) {
    if (!line.endsWith("…")) continue;
    const body = line.slice(0, -1);
    // The kept prefix must be a prefix of some source bullet, ending on a word.
    const source = SECTIONS.flatMap((s) => s.bullets).find((b) => b.text.startsWith(body));
    assert.ok(source, `truncated line is not a source prefix: ${JSON.stringify(line)}`);
    assert.match(source.text.charAt(body.length), /\s/, `mid-word cut: ${JSON.stringify(line)}`);
  }
  // A bullet that fits is reported truncated:false.
  const whole = projectTier1(SECTIONS, { query: "what's the weather" });
  assert.ok(whole.bullets.some((b) => b.truncated === false));
});

test("tier0: bullets[] is in rendered order and its provenance zips with the text", () => {
  // The visualiser maps each rendered line back to its source bullet; if these
  // two lists ever drift the used-vs-unused split is silently wrong.
  for (const maxChars of [P.DEFAULT_TIER0_MAX_CHARS, 1200, 600, 400, 300, 200]) {
    const t0 = projectTier0(SECTIONS, { maxChars });
    const lines = renderedLines(t0);
    assert.strictEqual(lines.length, t0.bullets.length, `line/provenance count drift at ${maxChars}`);
    lines.forEach((line, i) => {
      const prov = t0.bullets[i];
      assert.strictEqual(line.length, prov.injectedChars, `injectedChars drift at ${maxChars}[${i}]`);
      const source = SECTIONS.find((s) => s.name === prov.sectionName).bullets[prov.index];
      assert.ok(source, "provenance points at a real source bullet");
      const body = prov.truncated ? line.slice(0, -1) : line;
      assert.ok(source.text.startsWith(body), `line ${i} does not come from its claimed source`);
      assert.strictEqual(prov.sourceChars, source.chars);
      assert.strictEqual(prov.duty, "always");
    });
    // Rendered order = section order, then bullet index within a section.
    const secOrder = SECTIONS.map((s) => s.name);
    let prev = [-1, -1];
    for (const b of t0.bullets) {
      const key = [secOrder.indexOf(b.sectionName), b.index];
      assert.ok(key[0] > prev[0] || (key[0] === prev[0] && key[1] > prev[1]), "provenance out of order");
      prev = key;
    }
  }
});

test("tier0: a ## Core section, when present, wins verbatim", () => {
  const secs = parsePersona(
    "## Core\n- Answer in Vietnamese, artifacts in English.\n- Verify before claiming done.\n\n" +
      "## Preferences\n- Prefers pytest over unittest for new suites.\n"
  );
  assert.strictEqual(prefersCore(secs), true);
  assert.strictEqual(coreSection(secs).name, "Core");
  const t0 = projectTier0(secs);
  assert.strictEqual(
    t0.text,
    "## Core\n- Answer in Vietnamese, artifacts in English.\n- Verify before claiming done."
  );
  assert.ok(!t0.text.includes("pytest"), "Core must not be diluted by the computed projection");
  assert.ok(t0.bullets.every((b) => b.sectionName === "Core" && b.duty === "always"));
  // Core is trusted verbatim, so "Verify before claiming done." rides along even
  // though the heuristic would otherwise class it conditional.
  assert.strictEqual(projectPersona("## Core\n- Answer in Vietnamese.\n").usedCore, true);
  assert.strictEqual(prefersCore(parsePersona("## Core\n")), false, "an empty Core does not count");
  assert.strictEqual(prefersCore(SECTIONS), false);
});

test("tier0: no always-content at all yields an empty projection, not a throw", () => {
  const secs = parsePersona("## Environment\n- Workstation at /home/dev/x, CUDA 12.6, 64 GB RAM.\n");
  const t0 = projectTier0(secs);
  // budgetChars echoes the default budget. Assert against the CONSTANT, not a
  // literal: this test is about the shape of an empty projection, so pinning the
  // number here would break on every future budget change while testing nothing
  // about the budget. (It did: 1200 → 4800.)
  assert.deepStrictEqual(t0, {
    text: "", bullets: [], usedChars: 0, budgetChars: P.DEFAULT_TIER0_MAX_CHARS,
  });
  assert.deepStrictEqual(projectTier0([]).bullets, []);
  assert.deepStrictEqual(projectTier0(null).bullets, []);
});

// ── Tier 0 delivers WHOLE BULLETS ONLY ─────────────────────────────────────
//
// THE INVARIANT: no tier-0 bullet's `injectedChars` may ever be less than its
// `sourceChars`, at any budget, for any input. A bullet arrives entire or not
// at all.
//
// This replaced a "keep at least half the source" ratio, which was a PROXY for
// the property actually wanted — "the operative clause survived" — and the proxy
// does not hold. Standing Instructions #6 was delivered at 594 of 1145 chars
// (51,9%), passing the ratio while cutting away its "**Amended for govkit only**"
// carve-out: the agent received a STRICTER rule than the user wrote, with no
// signal that anything had been removed. Clause position does not correlate with
// length, so no ratio can detect that. A partial standing instruction is not a
// shorter instruction, it is a different one — and different is worse than
// absent, because an absent rule leaves the agent uninformed while a mangled one
// leaves it confidently wrong.
//
// Counter-intuitively this delivers MORE, not less: the four half-rules were
// consuming ~2 100 chars, and freeing them bought five whole bullets (12 → 13
// delivered, 4 truncated → 0).
//
// The cost is a real coverage cliff, so it is pinned as a PAIR with the
// accounting test below: DEFAULT_BULLET_MAX_CHARS stops being a truncation cap
// in tier 0 and becomes an ELIGIBILITY THRESHOLD, and a bullet longer than it can
// never be injected. "Nothing arrives partial" alone would happily certify a
// tier 0 that delivers nothing at all; "nothing vanishes unaccounted for" is what
// makes it safe. The fix for an over-long rule is on the WRITE side (one rule per
// bullet, operative clause first).

const LONG_RULE =
  "Never ship a schema change without a rollback script, and " +
  "the operative clause lives near the very end of this long standing instruction which is what makes truncation dangerous ".repeat(5) +
  "so always run the rollback rehearsal first.";
const SHORT_RULE = "Never force-push a shared branch.";

test("tier0: a bullet too long to fit is skipped whole, never delivered as a fragment", () => {
  assert.ok(LONG_RULE.length > P.DEFAULT_BULLET_MAX_CHARS, "fixture must exceed the eligibility cap");
  const secs = parsePersona(`## Standing Instructions\n- ${LONG_RULE}\n- ${SHORT_RULE}\n`);

  // At EVERY budget, including the most generous: an over-cap bullet is never
  // injected, and the shorter rule behind it still arrives whole rather than
  // being crowded out by a fragment of the one in front.
  for (const maxChars of [P.DEFAULT_TIER0_MAX_CHARS, 1000, 600, 300, 100]) {
    const t0 = projectTier0(secs, { maxChars });
    assert.deepStrictEqual(t0.bullets.map((b) => b.index), [1], `at maxChars=${maxChars}`);
    assert.ok(!t0.text.includes("Never ship a schema change"), t0.text);
    assert.ok(t0.text.includes(SHORT_RULE), "the shorter bullet behind it must still arrive");
    assert.strictEqual(t0.bullets[0].injectedChars, SHORT_RULE.length);
    assert.strictEqual(t0.bullets[0].truncated, false);
    // A skipped bullet leaves no orphan line.
    assert.strictEqual(renderedLines(t0).length, t0.bullets.length);
  }

  // No ellipsis anywhere in a tier-0 projection, ever.
  assert.ok(!projectTier0(SECTIONS).text.includes("…"));
});

test("tier0 INVARIANT: injectedChars always equals sourceChars, at every budget", () => {
  const secs = parsePersona(
    `## Standing Instructions\n- ${LONG_RULE}\n- ${SHORT_RULE}\n` +
      `- Always run the full suite before claiming a change is done, and paste the real output.\n\n` +
      `## Preferences\n- ${LONG_RULE}\n- Concise and direct answers; no filler.\n`
  );
  const sourceOf = (b) =>
    secs.find((s) => s.name === b.sectionName).bullets[b.index];

  for (let maxChars = P.DEFAULT_TIER0_MAX_CHARS; maxChars >= 0; maxChars -= 17) {
    for (const bulletMaxChars of [P.DEFAULT_BULLET_MAX_CHARS, 300, 150, 60]) {
      const t0 = projectTier0(secs, { maxChars, bulletMaxChars });
      const where = `maxChars=${maxChars} bulletMaxChars=${bulletMaxChars}`;

      for (const b of t0.bullets) {
        assert.strictEqual(b.injectedChars, b.sourceChars, `partial delivery at ${where}`);
        assert.strictEqual(b.truncated, false, `truncated flag set at ${where}`);
      }
      // …and the rendered line is the source bullet VERBATIM, not merely the same
      // length. Checking the count alone would miss a same-length rewrite.
      renderedLines(t0).forEach((line, i) => {
        assert.strictEqual(line, sourceOf(t0.bullets[i]).text, `line is not verbatim at ${where}`);
      });
      assert.ok(!t0.text.includes("…"), `ellipsis in tier 0 at ${where}`);
      assert.ok(t0.usedChars <= maxChars, `over budget at ${where}`);
      assert.strictEqual(renderedLines(t0).length, t0.bullets.length, `provenance drift at ${where}`);
    }
  }
});

test("tier0 INVARIANT (the pair): every always-bullet is either delivered whole or accounted for", () => {
  // "Nothing arrives partial" is only safe alongside "nothing vanishes
  // unaccounted for" — otherwise a tier 0 that delivers NOTHING satisfies it.
  // Every always-class bullet must be exactly one of: delivered verbatim, or
  // absent for a stateable reason (over the eligibility cap, or no budget left).
  const secs = parsePersona(
    `## Standing Instructions\n- ${LONG_RULE}\n- ${SHORT_RULE}\n\n` +
      `## Preferences\n- Concise and direct answers; no filler.\n- Prefers Vietnamese in chat, English in artifacts.\n`
  );
  const alwaysBullets = annotate(secs).flatMap((s) =>
    s.bullets.filter((b) => b.duty === "always").map((b) => ({ ...b, sectionName: s.name }))
  );
  assert.ok(alwaysBullets.length >= 4, "fixture must have enough always-class bullets");

  for (const maxChars of [P.DEFAULT_TIER0_MAX_CHARS, 800, 400, 200, 120, 0]) {
    const t0 = projectTier0(secs, { maxChars });
    const delivered = new Set(t0.bullets.map((b) => `${b.sectionName}#${b.index}`));
    let overCap = 0;
    let budgetBound = 0;

    for (const b of alwaysBullets) {
      const key = `${b.sectionName}#${b.index}`;
      if (delivered.has(key)) continue;
      if (b.chars > P.DEFAULT_BULLET_MAX_CHARS) { overCap++; continue; }
      // The only other admissible reason to be absent is that the budget ran out.
      assert.ok(
        t0.usedChars + b.chars + 3 > maxChars,
        `bullet ${key} (${b.chars} chars) vanished with room to spare at maxChars=${maxChars}`
      );
      budgetBound++;
    }
    assert.strictEqual(
      t0.bullets.length + overCap + budgetBound,
      alwaysBullets.length,
      `accounting does not balance at maxChars=${maxChars}`
    );
  }

  // The coverage cliff is real and must stay visible: an over-cap bullet is
  // undeliverable at ANY budget, not merely at a tight one.
  const cliff = projectTier0(secs, { maxChars: 100000 });
  assert.ok(!cliff.text.includes("Never ship a schema change"), "over-cap bullet leaked at a huge budget");
});

test("tier0: a round-0 reservation does not permanently lose an ELIGIBLE bullet", () => {
  // Round 0 caps each section to an equal share; that reservation is not the real
  // ceiling, so a bullet that only fails against it must be retried next round at
  // the full per-bullet cap rather than dropped. Fixture must sit UNDER the
  // eligibility cap (or it would be skipped outright, testing nothing) but OVER
  // the round-0 equal share (or the deferral never happens).
  const mid =
    "Never merge without a green suite, and " +
    "this rule carries a long tail of qualifying clauses that push it past the round zero equal share reservation ".repeat(4) +
    "end.";
  const secs = parsePersona(
    `## Preferences\n- Concise and direct answers everywhere; no filler at all whatsoever.\n\n` +
      `## Standing Instructions\n- ${mid}\n`
  );
  const maxChars = 1000;
  const headers = "## Preferences\n".length + "## Standing Instructions\n".length + 2;
  const roundZeroShare = Math.floor((maxChars - headers) / 2) - 3;

  assert.ok(mid.length <= P.DEFAULT_BULLET_MAX_CHARS, `fixture must be eligible: ${mid.length}`);
  assert.ok(mid.length > roundZeroShare, `fixture must exceed the round-0 share (~${roundZeroShare})`);

  const t0 = projectTier0(secs, { maxChars });
  const long = t0.bullets.find((b) => b.sectionName === "Standing Instructions");
  assert.ok(long, "the eligible bullet was lost to the round-0 reservation instead of being retried");
  assert.strictEqual(long.injectedChars, long.sourceChars, "retried bullet must still arrive whole");
  assert.ok(t0.text.includes(mid));
});

test("tier0: a source bullet with unbalanced ** is passed through verbatim", () => {
  // Tier 0 never rewrites a bullet — whole-or-nothing means whole, markers and
  // all. The dangling-marker REPAIR lives in truncateAtWord, which tier 0 no
  // longer calls, so a persona author who leaves a `**` unclosed will see it in
  // the preamble. That is a write-side defect, not something tier 0 launders, and
  // pinning it here keeps the difference from being mistaken for a regression in
  // the tier-1 repair.
  const secs = parsePersona(
    "## Preferences\n- **Always answer in Vietnamese and the bold is never closed here at all ok.\n"
  );
  const t0 = projectTier0(secs);
  assert.strictEqual(boldMarkers(t0.text) % 2, 1, "fixture must actually be unbalanced");
  assert.strictEqual(renderedLines(t0)[0], secs[0].bullets[0].text, "tier 0 must not rewrite the bullet");
});

test("tier1 truncates where tier 0 skips — the asymmetry is deliberate", () => {
  // Tier 1 is now the ONLY place truncation is legitimate. It is budget-POOR by
  // construction (420 chars for the whole channel, every turn), so a long bullet
  // ALWAYS lands under any ratio there. Applying tier 0's whole-or-nothing rule
  // would silently empty the insurance line — removing the very cover that exists
  // for when tier 0 was compacted away.
  //
  // The asymmetry is justified by what each tier IS: tier 0 is a contract (the
  // agent acts on it as the user's standing rule, so a mangled one is a wrong
  // one), tier 1 is cover (a partial reminder still points at the real rule).
  const longIns =
    "Always answer in Vietnamese in chat while every committed artifact stays in English, " +
    "and this rule has a great many qualifying clauses that push it well past the tier one budget ".repeat(4) +
    "no exceptions.";
  const secs = parsePersona(`## Preferences\n- ${longIns}\n`);

  // Same bullet, same module, opposite treatment — that is the whole point.
  const t1 = projectTier1(secs, { query: "anything at all" });
  assert.strictEqual(t1.bullets.length, 1, "the insurance line was dropped");
  assert.strictEqual(t1.bullets[0].reason, "insurance");
  assert.strictEqual(t1.bullets[0].truncated, true, "tier 1 must still be willing to cut");
  assert.ok(
    t1.bullets[0].injectedChars < t1.bullets[0].sourceChars,
    "fixture must actually be cut in tier 1, or it proves nothing"
  );

  // Tier 0 delivers the very same bullet WHOLE (it is under the eligibility cap).
  const t0 = projectTier0(secs);
  assert.strictEqual(t0.bullets.length, 1);
  assert.strictEqual(t0.bullets[0].injectedChars, t0.bullets[0].sourceChars);
  assert.ok(t0.text.includes(longIns), "tier 0 must deliver it verbatim");

  // And the main fixture keeps its insurance line at every tier-1 budget.
  for (const maxChars of [P.DEFAULT_TIER1_MAX_CHARS, 300, 200, 120]) {
    const t = projectTier1(SECTIONS, { query: "what's the weather", maxChars });
    assert.ok(t.bullets.some((b) => b.reason === "insurance"), `no insurance at maxChars=${maxChars}`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Tier 1: per-turn
// ───────────────────────────────────────────────────────────────────────────

test("tier1: the insurance line is always present, whatever the query", () => {
  for (const query of ["", "what's the weather", "database migration", "làm sao để chạy test"]) {
    const t1 = projectTier1(SECTIONS, { query });
    const ins = t1.bullets.filter((b) => b.reason === "insurance");
    assert.ok(ins.length >= 1, `no insurance line for ${JSON.stringify(query)}`);
    assert.ok(ins.length <= 2, "insurance is capped at 2 lines");
    assert.ok(ins.every((b) => b.duty === "always"), "insurance must come from the always class");
    // Insurance leads the projection.
    assert.strictEqual(t1.bullets[0].reason, "insurance");
  }
});

test("tier1: an unrelated query yields insurance only", () => {
  const t1 = projectTier1(SECTIONS, { query: "what's the weather" });
  assert.ok(t1.bullets.every((b) => b.reason === "insurance"), JSON.stringify(t1.bullets));
  assert.ok(!t1.text.includes("migration"));
  assert.ok(!t1.text.includes("verifying"));
});

test("tier1: relevance selects the right conditional bullet for the query", () => {
  const mig = projectTier1(SECTIONS, { query: "run a database migration on staging" });
  const rel = mig.bullets.filter((b) => b.reason === "relevance");
  assert.ok(rel.length >= 1, "expected a relevance hit");
  assert.match(mig.text, /Before any database migration/);
  assert.ok(rel.every((b) => b.duty === "conditional"), "only conditional items ride tier 1");
  assert.ok(rel[0].score >= 0.12 && rel[0].score <= 1);
  // Highest score first.
  const scores = rel.map((b) => b.score);
  assert.deepStrictEqual(scores, [...scores].sort((a, b) => b - a));

  const verify = projectTier1(SECTIONS, { query: "how do I verify a claim about the command output" });
  assert.match(verify.text, /When verifying a claim/);
  assert.ok(!verify.text.includes("database migration"));
});

test("tier1: no duplicate bullet is injected twice", () => {
  const t1 = projectTier1(SECTIONS, { query: "database migration verifying a claim command output" });
  const keys = t1.bullets.map((b) => `${b.sectionName}#${b.index}`);
  assert.strictEqual(new Set(keys).size, keys.length);
});

test("tier1: budgets are respected and degrade cleanly to empty", () => {
  for (const maxChars of [P.DEFAULT_TIER1_MAX_CHARS, 300, 200, 120, 90, MIN_BULLET_CHARS, 30, 1, 0]) {
    const t1 = projectTier1(SECTIONS, { query: "database migration", maxChars });
    assert.strictEqual(t1.budgetChars, maxChars);
    assert.strictEqual(t1.usedChars, t1.text.length);
    assert.ok(t1.usedChars <= maxChars, `used ${t1.usedChars} > budget ${maxChars}`);
    assert.strictEqual(renderedLines(t1).length, t1.bullets.length);
  }
  // A tiny insurance slice still leaves room for relevance within the overall budget.
  const t1 = projectTier1(SECTIONS, { query: "database migration", insuranceChars: 0 });
  assert.ok(t1.bullets.every((b) => b.reason === "relevance"));
  assert.match(t1.text, /database migration/);
});

test("tier1: minScore gates weak matches", () => {
  const loose = projectTier1(SECTIONS, { query: "database", minScore: 0 });
  const strict = projectTier1(SECTIONS, { query: "database", minScore: 0.99 });
  assert.ok(
    loose.bullets.filter((b) => b.reason === "relevance").length >=
      strict.bullets.filter((b) => b.reason === "relevance").length
  );
});

test("tier1: empty persona is an empty projection, not a throw", () => {
  assert.deepStrictEqual(projectTier1([], { query: "x" }).bullets, []);
  assert.deepStrictEqual(projectTier1(null, { query: "x" }).bullets, []);
  assert.strictEqual(projectTier1(SECTIONS, { query: "x", maxChars: 0 }).text, "");
});

test("tier1: relevanceScore is a bounded 0..1 share", () => {
  assert.strictEqual(P.relevanceScore("anything", new Set(), null), 0);
  assert.strictEqual(P.relevanceScore("", new Set(["x"]), null), 0);
  const s = P.relevanceScore("database migration snapshot", new Set(["database", "weather"]), null);
  assert.ok(s > 0 && s <= 1, s);
});

// ───────────────────────────────────────────────────────────────────────────
// Fallback: the legacy projection
// ───────────────────────────────────────────────────────────────────────────

test("legacyProjection reproduces first-5-non-heading-lines joined with '; '", () => {
  assert.strictEqual(legacyProjection("# H\n## S\n- a\n- b\n- c\n- d\n- e\n- f\n- g"), "a; b; c; d; e");
  assert.strictEqual(legacyProjection("# H\n- a\n- b"), "a; b");
  // Non-bullet prose lines count too.
  assert.strictEqual(legacyProjection("alpha\nbeta\n- gamma"), "alpha; beta; gamma");
  assert.strictEqual(legacyProjection("- a\n- b\n- c", { maxLines: 2 }), "a; b");
});

test("legacyProjection truncates at 400 chars on a word boundary with a trailing '...'", () => {
  const long = Array.from({ length: 5 }, (_, i) => `- ${`word${i} `.repeat(30)}`).join("\n");
  const out = legacyProjection(long);
  assert.ok(out.endsWith("..."), out.slice(-10));
  const body = out.slice(0, -3);
  // The "..." is APPENDED after the 400-char cut, so the body obeys the cap but
  // the returned string can overshoot it by up to 3.
  assert.ok(body.length <= LEGACY_MAX_CHARS, `body ${body.length} > ${LEGACY_MAX_CHARS}`);
  assert.ok(out.length <= LEGACY_MAX_CHARS + 3, out.length);

  const joined = legacyProjection(long, { maxChars: Infinity });
  assert.ok(joined.startsWith(body), "the kept text is a prefix of the untruncated join");
  assert.match(joined.charAt(body.length), /\s/, "legacy cut landed mid-word");

  // When the word boundary sits at the very end of the 400-char slice the
  // appended ellipsis pushes the result to 401 — the cap bounds the CUT, not the
  // returned string.
  const dense = Array.from({ length: 5 }, () => `- ${"xxxxxx ".repeat(60)}`).join("\n");
  const overshoot = legacyProjection(dense);
  assert.strictEqual(overshoot.length, 401);
  assert.ok(overshoot.endsWith("..."));
});

test("legacyProjection: empty / garbage persona yields '' and never throws", () => {
  assert.strictEqual(legacyProjection(""), "");
  assert.strictEqual(legacyProjection(null), "");
  assert.strictEqual(legacyProjection(undefined), "");
  assert.strictEqual(legacyProjection("   \n\n  "), "");
  assert.strictEqual(legacyProjection("# only\n## headings\n### here"), "");
  assert.strictEqual(legacyProjection("!!! ??? ###"), "!!! ??? ###");
});

test("projectPersona: fallback fires only when tier 0 is empty", () => {
  const rich = projectPersona(PERSONA);
  assert.ok(rich.tier0.text.length > 0);
  assert.strictEqual(rich.fallback, "", "no fallback when the tiered projection produced text");
  assert.strictEqual(rich.usedCore, false);

  const poor = projectPersona("## Environment\n- Workstation at /home/dev/x, CUDA 12.6, 64 GB RAM.\n");
  assert.strictEqual(poor.tier0.text, "");
  assert.strictEqual(poor.fallback, "Workstation at /home/dev/x, CUDA 12.6, 64 GB RAM.");

  const empty = projectPersona("");
  assert.deepStrictEqual(empty.sections, []);
  assert.strictEqual(empty.tier0.text, "");
  assert.strictEqual(empty.tier1.text, "");
  assert.strictEqual(empty.fallback, "");

  for (const junk of [null, undefined, "   ", "!!! ??? ###", "\x00\x01"]) {
    assert.doesNotThrow(() => projectPersona(junk), String(junk));
  }
});

// ───────────────────────────────────────────────────────────────────────────
// truncateAtWord + budget sweep invariants
// ───────────────────────────────────────────────────────────────────────────

test("truncateAtWord: word boundary, ellipsis, and bold balance", () => {
  assert.deepStrictEqual(truncateAtWord("hello world foo", 100), { text: "hello world foo", truncated: false });
  assert.deepStrictEqual(truncateAtWord("hello world foo bar", 12), { text: "hello…", truncated: true });
  // A single token longer than the cap has no boundary to find: a hard cut beats
  // dropping the bullet entirely.
  assert.deepStrictEqual(truncateAtWord("supercalifragilisticexpialidocious", 10), {
    text: "supercali…",
    truncated: true,
  });
  assert.deepStrictEqual(truncateAtWord("abc", 0), { text: "", truncated: true });
  assert.deepStrictEqual(truncateAtWord("", 50), { text: "", truncated: false });
  assert.deepStrictEqual(truncateAtWord(null, 50), { text: "", truncated: false });
  // Trailing punctuation is trimmed off the cut.
  assert.deepStrictEqual(truncateAtWord("alpha beta gamma delta,", 20), { text: "alpha beta gamma…", truncated: true });
  // A closed bold pair survives; a would-be dangling opener is dropped.
  assert.strictEqual(boldMarkers(truncateAtWord("**bold** tail wordwordword", 14).text) % 2, 0);
  assert.strictEqual(boldMarkers(truncateAtWord("**alpha beta** gamma delta epsilon", 20).text) % 2, 0);
});

// ── Dangling `**` regression ────────────────────────────────────────────────
//
// An unbalanced `**` in an injected block makes the host's markdown renderer
// treat everything after it as bold and swallow the rest of the block — so ONE
// over-long bold label could erase an entire session preamble, silently, with no
// error raised anywhere. The balance repair in truncateAtWord used to reduce the
// cut to "" when the bold OPENER sat at index 0 and its closer was past the cap;
// the empty-result escape hatch then restored the raw slice, re-introducing the
// very marker the repair had just removed.
//
// It was reachable through projectTier0 — not just the helper — but only with a
// per-bullet cap BELOW the default, which is why a sweep that only used the
// default value passed. Hence the sub-default sweep below.

test("truncateAtWord REGRESSION: never returns an unbalanced ** marker", () => {
  const cases = [
    ["**Averyveryverylongboldlabelhere** rest of it", 20],
    ["**abc", 4],
    ["**a b**", 3],          // repair empties the cut — the escape hatch path
    ["**bold** ok", 6],
    ["nospaceatallhere", 5], // no whitespace at all: hard cut, still balanced
  ];
  for (const [text, cap] of cases) {
    const { text: out } = truncateAtWord(text, cap);
    assert.strictEqual(boldMarkers(out) % 2, 0, `unbalanced ** for ${JSON.stringify(text)}@${cap}: ${out}`);
    assert.ok(out.length <= cap, `over cap for ${JSON.stringify(text)}@${cap}: ${JSON.stringify(out)}`);
  }
  // The repair drops the marker rather than the content.
  assert.strictEqual(truncateAtWord("**Averyveryverylongboldlabelhere** rest of it", 20).text, "Averyveryverylong…");
  assert.strictEqual(truncateAtWord("**a b**", 3).text, "", "an unrescuable cut yields empty, not a raw slice");
  // A pair that fits is left alone.
  assert.deepStrictEqual(truncateAtWord("**alpha beta** gamma", 20), { text: "**alpha beta** gamma", truncated: false });
  assert.strictEqual(truncateAtWord("**bold** tail wordwordword", 14).text, "**bold**…");
});

test("tier1 REGRESSION: a bold label longer than the per-bullet cap never leaks a marker", () => {
  // Re-aimed from tier 0. Tier 0 no longer truncates, so it can no longer produce
  // a dangling marker — asserting this against tier 0 would pass VACUOUSLY (both
  // fixtures are simply skipped and t0.text is empty). Tier 1 is now the only
  // path that reaches the repair, so the guard has to live here.
  const label = `**${"Alwaysanswerineverysinglecaseinvietnameseandalsoenglishnomatterwhathappens"}**`;
  assert.ok(label.length > 60, "fixture must exceed the cap under test");
  const secs = parsePersona(
    `## Preferences\n- ${label} concise and direct, yes really do it every single time.\n`
  );
  const t1 = projectTier1(secs, { query: "anything", bulletMaxChars: 60 });

  // Fixture guard: this must genuinely truncate, or the test has gone vacuous
  // exactly the way its tier-0 predecessor did.
  assert.ok(t1.bullets.length > 0, "fixture delivered nothing — test is vacuous");
  assert.strictEqual(t1.bullets[0].truncated, true, "fixture no longer truncates — test is vacuous");

  assert.strictEqual(boldMarkers(t1.text) % 2, 0, t1.text);
  for (const line of renderedLines(t1)) {
    assert.strictEqual(boldMarkers(line) % 2, 0, `unbalanced ** on line: ${line}`);
  }
  assert.ok(!t1.text.includes("**"), "the unclosable opener is dropped, not carried");
  assert.ok(t1.text.includes("Alwaysanswerineverysingle"), "content survives the marker removal");

  // Consequence worth stating for whoever writes the visualiser: when the repair
  // strips a marker the rendered line is NO LONGER a literal prefix of its source
  // bullet. Provenance is still exact — sectionName/index/injectedChars all zip —
  // so map line→bullet by INDEX, never by substring-matching the source text.
  // (This only ever applies to tier 1 now; tier-0 lines are always verbatim.)
  const line = renderedLines(t1)[0];
  const source = secs[0].bullets[t1.bullets[0].index];
  assert.strictEqual(line.length, t1.bullets[0].injectedChars);
  assert.strictEqual(t1.bullets[0].sourceChars, source.chars);
  assert.ok(!source.text.startsWith(line.slice(0, -1)), "prefix-matching is not a safe provenance strategy here");
});

test("dangling ** sweep: balance holds across tier-1 caps, including below the default", () => {
  // Re-aimed at tier 1: it is now the only tier that truncates, so it is the only
  // tier that can produce a dangling marker. The tier-0 half of this sweep would
  // now pass vacuously (whole bullets in, whole bullets out), so tier 0 is swept
  // for the property it DOES have — verbatim delivery — instead.
  const long = `**${"Alwaysanswerineverysinglecaseinvietnameseandalsoenglishnomatterwhathappens"}**`;
  const mid = "**Language discipline**";
  const secs = parsePersona(
    `## Preferences\n- ${long} yes really do it every single time no exceptions.\n` +
      `- ${mid}: always answer in Vietnamese while every committed artifact remains in English.\n` +
      `- Concise and direct answers always; no filler and no restating the question.\n\n` +
      `## Standing Instructions\n` +
      `- **No AI attribution** trailers in commits. All committed artifacts English; VI in chat only.\n` +
      `- Never force-push a shared branch under any circumstances whatsoever.\n`
  );
  const sourceText = new Map(
    secs.flatMap((s) => s.bullets.map((b) => [`${s.name}#${b.index}`, b.text]))
  );

  let truncatedSeen = 0;
  let lines = 0;
  const caps = [60, 62, 65, 70, 75, 80, 90, 100, 120, 160, 200, 240, 400, P.DEFAULT_BULLET_MAX_CHARS];
  assert.ok(caps[0] < P.DEFAULT_BULLET_MAX_CHARS, "sweep must reach below the default per-bullet cap");

  for (const bulletMaxChars of caps) {
    for (const maxChars of [P.DEFAULT_TIER1_MAX_CHARS, 380, 300, 240, 180, 120, 90]) {
      const where = `maxChars=${maxChars} bulletMaxChars=${bulletMaxChars}`;
      const t1 = projectTier1(secs, {
        query: "vietnamese english commits force-push", maxChars, bulletMaxChars,
      });
      assert.strictEqual(boldMarkers(t1.text) % 2, 0, `dangling ** in tier1 at ${where}: ${t1.text}`);
      assert.ok(t1.usedChars <= maxChars, `tier1 over budget at ${where}`);
      for (const line of renderedLines(t1)) {
        assert.strictEqual(boldMarkers(line) % 2, 0, `dangling ** on a tier1 line at ${where}: ${line}`);
        lines++;
      }
      truncatedSeen += t1.bullets.filter((b) => b.truncated).length;
    }
  }
  assert.ok(lines > 100, `sweep was too thin to be meaningful (${lines} lines)`);
  assert.ok(truncatedSeen > 20, `sweep barely truncated (${truncatedSeen}) — it has gone vacuous`);

  // Tier 0 over the same fixture: every delivered line verbatim, markers exactly
  // as the author wrote them, never an ellipsis.
  for (const maxChars of [P.DEFAULT_TIER0_MAX_CHARS, 1600, 1200, 800, 500, 350, 250, 180, 120, 90]) {
    const t0 = projectTier0(secs, { maxChars });
    const where = `maxChars=${maxChars}`;
    assert.ok(t0.usedChars <= maxChars, `tier0 over budget at ${where}`);
    assert.ok(!t0.text.includes("…"), `tier0 ellipsis at ${where}`);
    renderedLines(t0).forEach((line, i) => {
      const key = `${t0.bullets[i].sectionName}#${t0.bullets[i].index}`;
      assert.strictEqual(line, sourceText.get(key), `tier0 line not verbatim at ${where}`);
    });
  }
});

test("budget sweep: tier 0 invariants hold from generous down to tiny", () => {
  const secs = parsePersona(
    `## Preferences
- **Language discipline**: always answer in Vietnamese while every single committed artifact remains in English regardless of the surrounding conversation register.
- Concise and direct answers; no filler, no restating the question back to the user.
- Prefers pytest over unittest for every new Python test suite in the repository.

## Standing Instructions
- No AI attribution trailers in commits. All committed artifacts English; VI in chat only.
- Never force-push a shared branch under any circumstances whatsoever, not even after a rebase.

## Working Style
- Reviews diffs bottom-up, always reading the tests before the implementation itself.
`
  );
  const byKey = new Map(
    secs.flatMap((s) => s.bullets.map((b) => [`${s.name}#${b.index}`, b]))
  );

  for (let maxChars = 1600; maxChars >= 0; maxChars -= 7) {
    const t0 = projectTier0(secs, { maxChars });
    const where = `maxChars=${maxChars}`;

    assert.ok(t0.usedChars <= maxChars, `over budget at ${where}: ${t0.usedChars}`);
    assert.strictEqual(t0.usedChars, t0.text.length, where);
    assert.strictEqual(boldMarkers(t0.text) % 2, 0, `dangling bold at ${where}: ${t0.text}`);
    // No word-boundary check any more: tier 0 makes no cut to land badly. The
    // stronger property replaces it — every line is its source bullet verbatim.
    assert.ok(!t0.text.includes("…"), `ellipsis at ${where}`);

    const lines = renderedLines(t0);
    assert.strictEqual(lines.length, t0.bullets.length, `provenance drift at ${where}`);
    lines.forEach((line, i) => {
      const prov = t0.bullets[i];
      const source = byKey.get(`${prov.sectionName}#${prov.index}`);
      assert.ok(source, `orphan line at ${where}: ${JSON.stringify(line)}`);
      assert.strictEqual(line, source.text, `line not verbatim at ${where}`);
      assert.strictEqual(prov.injectedChars, prov.sourceChars, `partial delivery at ${where}`);
      assert.strictEqual(prov.truncated, false, where);
    });
  }
});

test("budget sweep: tier 1 never exceeds its budget", () => {
  for (let maxChars = 600; maxChars >= 0; maxChars -= 3) {
    for (const query of ["", "database migration", "verify the command output"]) {
      const t1 = projectTier1(SECTIONS, { query, maxChars });
      assert.ok(t1.usedChars <= maxChars, `over budget maxChars=${maxChars} q=${query}`);
      assert.strictEqual(boldMarkers(t1.text) % 2, 0, `dangling bold maxChars=${maxChars}`);
    }
  }
});
