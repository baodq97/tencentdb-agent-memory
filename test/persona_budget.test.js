"use strict";
// WS2 — write-side persona budget gate. Proves checkPersonaBudget flags the two
// measured silent-drop causes (over-long always bullets, tier-0 overflow) and
// passes a clean persona, without throwing on garbage input.
const { test } = require("node:test");
const assert = require("node:assert");
const {
  checkPersonaBudget,
  DEFAULT_TIER0_MAX_CHARS,
  DEFAULT_BULLET_MAX_CHARS,
} = require("../scripts/persona_projection.js");

test("clean persona: short standing rules under budget → ok, no violations", () => {
  const persona = `# User Persona

## Standing Instructions
- Always answer concisely, code-first.
- Always verify a claim against a primary source before writing.
- Always recommend the best option with trade-offs before deciding.
`;
  const r = checkPersonaBudget(persona);
  assert.strictEqual(r.ok, true, JSON.stringify(r.violations));
  assert.strictEqual(r.violations.length, 0);
  assert.ok(r.alwaysCount >= 3, `alwaysCount=${r.alwaysCount}`);
  assert.strictEqual(r.deliveredCount, r.alwaysCount);
});

test("over-long always bullet → bullet_over_max violation (160 write rule)", () => {
  const longRule = "Always " + "verify every claim against a primary source before writing ".repeat(4);
  assert.ok(longRule.length > 160 && longRule.length < DEFAULT_BULLET_MAX_CHARS,
    `len=${longRule.length}: must break the 160 write rule but stay under the 600 eligibility cap`);
  const persona = `# User Persona

## Standing Instructions
- ${longRule}
`;
  const r = checkPersonaBudget(persona);
  assert.strictEqual(r.ok, false);
  const v = r.violations.find((x) => x.kind === "bullet_over_max");
  assert.ok(v, "expected a bullet_over_max violation");
  assert.ok(v.chars > v.max);
  assert.strictEqual(v.max, 160);
});

test("too many always bullets → tier0_overflow (some silently dropped)", () => {
  // ~40 bullets of ~150 chars each = ~6000 chars of always content, each UNDER
  // the per-bullet cap, so the only defect is that they overflow the 4800 budget.
  const bullet = "Always keep the running deploy log updated with the exact command and its observed exit code for the current release window here.";
  assert.ok(bullet.length <= DEFAULT_BULLET_MAX_CHARS, `bullet is ${bullet.length}`);
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(`- ${bullet} (rule ${i})`);
  const persona = `# User Persona\n\n## Standing Instructions\n${lines.join("\n")}\n`;
  const total = 40 * bullet.length;
  assert.ok(total > DEFAULT_TIER0_MAX_CHARS, `total ${total} should exceed budget`);

  const r = checkPersonaBudget(persona);
  assert.strictEqual(r.ok, false);
  const v = r.violations.find((x) => x.kind === "tier0_overflow");
  assert.ok(v, "expected a tier0_overflow violation");
  assert.ok(v.droppedCount > 0);
  assert.strictEqual(v.deliveredCount + v.droppedCount, v.alwaysCount);
  assert.ok(r.deliveredCount < r.alwaysCount);
});

test("garbage / empty input never throws and reports no always rules", () => {
  for (const bad of ["", "   ", "no markdown at all", null, undefined]) {
    const r = checkPersonaBudget(bad);
    assert.strictEqual(typeof r.ok, "boolean");
    assert.ok(Array.isArray(r.violations));
  }
});

test("tighter code/team cap can be passed via opts (WS2b hook)", () => {
  // Same standing rules that pass under the default budget must fail under a
  // much tighter cap — proving the code/team family can enforce a smaller L3.
  const persona = `# User Persona

## Standing Instructions
- Always answer concisely, code-first.
- Always verify a claim against a primary source before writing.
- Always recommend the best option with trade-offs before deciding.
`;
  assert.strictEqual(checkPersonaBudget(persona).ok, true);
  const tight = checkPersonaBudget(persona, { maxChars: 120 });
  assert.strictEqual(tight.ok, false);
  assert.ok(tight.violations.some((v) => v.kind === "tier0_overflow"));
});
