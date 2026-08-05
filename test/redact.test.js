// test/redact.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const {
  isSensitive,
  redactSensitive,
  SENSITIVE_PATTERNS,
} = require("../scripts/redact.js");

// NOTE: all fixtures below are SYNTHETIC / fake. Do not paste real secrets here.

const SECRET_FIXTURES = [
  // WorkOS-style OAuth redirect URI
  "WORKOS_REDIRECT_URI=https://example.com/callback?redirect_uri=https://app.example.com/auth",
  // A bare prod redirect URL
  "Login flow uses https://auth.example.com/oauth/callback?redirect_uri=https%3A%2F%2Fapp.example.com",
  // Fake Azure subscription UUID in context
  "Azure subscription id 123e4567-e89b-12d3-a456-426614174000 for the prod tenant",
  // Fake Azure tenant id in context
  "az login --tenant 00000000-1111-2222-3333-444444444444",
  // Generic *_SECRET= assignment
  "FOO_SECRET=super-not-a-real-value-000",
  // Generic *_TOKEN= assignment
  "GITHUB_TOKEN=ghp_000000000000000000000000000000000000",
  // Generic *_KEY= assignment
  "STRIPE_API_KEY=sk_test_00000000000000000000000000",
  // JWT-shaped token (three base64url segments) — synthetic
  "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMDAwIn0.ZmFrZS1zaWduYXR1cmUtbm90LXJlYWw",
  // AWS access key id shape (fake)
  "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
  // Private hostname
  "deploy target is prod-db-01.internal.corp:5432",
];

const BENIGN_FIXTURES = [
  "user prefers concise Vietnamese answers",
  "The team ships on Fridays and reviews PRs in the morning.",
  "Người dùng thích trả lời ngắn gọn bằng tiếng Việt.",
  "Remember to run the tests before committing.",
  "The meeting is at 3pm about the roadmap for Q4.",
];

test("SENSITIVE_PATTERNS is an inspectable table", () => {
  assert.ok(Array.isArray(SENSITIVE_PATTERNS), "expected an array");
  assert.ok(SENSITIVE_PATTERNS.length > 0, "expected at least one rule");
  for (const rule of SENSITIVE_PATTERNS) {
    assert.strictEqual(typeof rule.kind, "string");
    assert.ok(rule.pattern instanceof RegExp, "each rule has a RegExp pattern");
  }
});

test("isSensitive flags every known-secret fixture (0 false-negatives)", () => {
  for (const fixture of SECRET_FIXTURES) {
    assert.strictEqual(
      isSensitive(fixture),
      true,
      `expected sensitive: ${fixture}`
    );
  }
});

test("isSensitive does NOT flag benign prose (low false-positive)", () => {
  for (const fixture of BENIGN_FIXTURES) {
    assert.strictEqual(
      isSensitive(fixture),
      false,
      `expected benign: ${fixture}`
    );
  }
});

test("redactSensitive masks secret spans with a placeholder", () => {
  for (const fixture of SECRET_FIXTURES) {
    const redacted = redactSensitive(fixture);
    assert.match(redacted, /‹redacted:[a-z0-9_-]+›/i, `expected placeholder in: ${redacted}`);
    assert.strictEqual(
      isSensitive(redacted),
      false,
      `redacted output must no longer be sensitive: ${redacted}`
    );
  }
});

test("redactSensitive leaves benign prose unchanged", () => {
  for (const fixture of BENIGN_FIXTURES) {
    assert.strictEqual(redactSensitive(fixture), fixture);
  }
});

test("graceful on empty / non-string input", () => {
  assert.strictEqual(isSensitive(""), false);
  assert.strictEqual(isSensitive(null), false);
  assert.strictEqual(isSensitive(undefined), false);
  assert.strictEqual(redactSensitive(""), "");
  assert.strictEqual(redactSensitive(null), "");
});
