"use strict";
// Upgrade nudges — after the redesign, existing stores keep the old shape until
// re-consolidation (no schema migration is needed). buildUpgradeNudges flags the
// stores that would benefit, so `tmem doctor` can point the user at consolidation.
const { test } = require("node:test");
const assert = require("node:assert");
const { buildUpgradeNudges } = require("../scripts/doctor.js");

function bloatedPersona(n) {
  const lines = ["# User Persona", "", "## Standing Instructions"];
  for (let i = 0; i < n; i++) {
    lines.push(`- Always keep standing rule ${i} short, operative and clear for the agent to follow here.`);
  }
  return lines.join("\n") + "\n";
}

test("over-budget global persona → re-consolidate nudge", () => {
  // ~70 short always-rules (~6000 chars) overflow the default 4800 tier-0 budget.
  const nudges = buildUpgradeNudges({ globalPersona: bloatedPersona(70) });
  assert.ok(nudges.some((n) => /over budget/i.test(n) && /memory-consolidate/.test(n)));
});

test("secret in global persona → scrub nudge", () => {
  const persona = "# User Persona\n\n## Standing Instructions\n- Always deploy via azure subscription 550e8400-e29b-41d4-a716-446655440000.\n";
  const nudges = buildUpgradeNudges({ globalPersona: persona });
  assert.ok(nudges.some((n) => /sensitive|leak/i.test(n)));
});

test("project has atoms but no doctrine → build-doctrine nudge", () => {
  const nudges = buildUpgradeNudges({ projectAtomCount: 12, projectPersona: "" });
  assert.ok(nudges.some((n) => /Operating Doctrine|guardrails/.test(n) && /12 memories/.test(n)));
});

test("global atoms exist but persona is empty/lost → recovery nudge", () => {
  // P2.5 parity: memories were captured but the persona document is missing or
  // was wiped — nudge a re-consolidation to rebuild it.
  const nudges = buildUpgradeNudges({ globalPersona: "", globalAtomCount: 20 });
  assert.ok(nudges.some((n) => /persona/i.test(n) && /memory-consolidate/.test(n)));
});

test("empty global persona with NO atoms → no recovery nudge (nothing to rebuild from)", () => {
  assert.deepStrictEqual(buildUpgradeNudges({ globalPersona: "", globalAtomCount: 0 }), []);
});

test("clean global + project already has doctrine → no nudges", () => {
  const clean = "# User Persona\n\n## Standing Instructions\n- Always answer concisely.\n";
  const nudges = buildUpgradeNudges({
    globalPersona: clean,
    projectAtomCount: 12,
    projectPersona: "# Team Operating Doctrine\n\n## Agent Rules\n- Run tests before push.\n",
  });
  assert.deepStrictEqual(nudges, []);
});

test("empty everything → no nudges, no throw", () => {
  assert.deepStrictEqual(buildUpgradeNudges({}), []);
  assert.deepStrictEqual(buildUpgradeNudges(), []);
});
