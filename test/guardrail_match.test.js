"use strict";
// WS3 — the PreToolUse guardrail matcher. A pending command matches the relevant
// stored anti-pattern; unrelated commands stay silent (no false alarms).
const { test } = require("node:test");
const assert = require("node:assert");
const { matchGuardrails, commandSignature } = require("../scripts/guardrail_match.js");

const GUARDRAILS = [
  { content: "Don't pkill a bound server (SIGTERM 144); kill the specific serve.js PID instead." },
  { content: "Before push or PR in this repo, run gh auth switch to the baodq97 account." },
  { content: "Azure Container Apps job --args must be separate tokens, not one quoted string." },
];

test("a pending pkill on serve.js surfaces the SIGTERM anti-pattern (only)", () => {
  const m = matchGuardrails("pkill -f serve.js", GUARDRAILS);
  assert.ok(m.length >= 1, "expected a match");
  assert.match(m[0].atom.content, /SIGTERM/);
  // must not also fire the unrelated gh-auth / azure guardrails
  assert.ok(!m.some((x) => /gh auth|Azure/.test(x.atom.content)), "no false matches");
});

test("a gh push command surfaces the account-switch guardrail", () => {
  const m = matchGuardrails("git push origin main && gh pr create", GUARDRAILS);
  assert.ok(m.some((x) => /gh auth switch/.test(x.atom.content)));
});

test("an unrelated command matches nothing (no false alarms)", () => {
  const m = matchGuardrails("ls -la src/components", GUARDRAILS);
  assert.deepStrictEqual(m, []);
});

test("empty / garbage command is safe", () => {
  assert.deepStrictEqual(matchGuardrails("", GUARDRAILS), []);
  assert.deepStrictEqual(matchGuardrails(null, GUARDRAILS), []);
  assert.deepStrictEqual(matchGuardrails("pkill serve.js", null), []);
});

test("commandSignature drops command noise words", () => {
  const sig = commandSignature("sudo run the pkill serve.js");
  assert.ok(sig.has("pkill"));
  assert.ok(!sig.has("sudo") && !sig.has("run") && !sig.has("the"));
});
