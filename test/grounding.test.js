// test/grounding.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { isGrounded, significantTokens, filterGrounded } = require("../scripts/grounding.js");

test("keeps memory grounded in source (English)", () => {
  const ok = isGrounded(
    "User prefers concise TypeScript examples.",
    "Please remember that I prefer concise TypeScript examples."
  );
  assert.strictEqual(ok, true);
});

test("drops memory not grounded in source (confabulation)", () => {
  const ok = isGrounded(
    "User is a professional violinist living in Berlin.",
    "Please remember that I prefer concise TypeScript examples."
  );
  assert.strictEqual(ok, false);
});

test("drops confabulation even when short words coincide (no substring false-positive)", () => {
  // "is"/"in" must NOT match inside "concise"/"working"; only real token overlap counts.
  const ok = isGrounded(
    "User is a professional violinist living in Berlin.",
    "Please remember I prefer concise TypeScript examples and I work in Hanoi."
  );
  assert.strictEqual(ok, false);
});

test("keeps grounded Vietnamese memory (Unicode-aware)", () => {
  const ok = isGrounded(
    "Người dùng thích trả lời ngắn gọn bằng tiếng Việt.",
    "cho tôi xin trả lời ngắn gọn bằng tiếng Việt nhé"
  );
  assert.strictEqual(ok, true);
});

test("graceful: empty/absent source text accepts (cannot disprove)", () => {
  assert.strictEqual(isGrounded("anything at all here", ""), true);
  assert.strictEqual(isGrounded("anything at all here", null), true);
});

test("filterGrounded resolves source_message_ids and drops confabulation", () => {
  const idToText = new Map([
    ["m1", "Please remember that I prefer concise TypeScript examples."],
    ["m2", "cho tôi xin trả lời ngắn gọn bằng tiếng Việt nhé"],
  ]);
  const records = [
    { content: "User prefers concise TypeScript examples.", source_message_ids: ["m1"] },
    { content: "User is a professional violinist living in Berlin.", source_message_ids: ["m1"] },
    { content: "Người dùng thích trả lời ngắn gọn bằng tiếng Việt.", source_message_ids: ["m2"] },
  ];
  const { kept, dropped } = filterGrounded(records, idToText);
  assert.strictEqual(kept.length, 2);
  assert.strictEqual(dropped.length, 1);
  assert.match(dropped[0].content, /violinist/);
});

test("filterGrounded is graceful: empty or unresolvable ids are kept", () => {
  const records = [
    { content: "fact with no source ids", source_message_ids: [] },
    { content: "fact with unknown id", source_message_ids: ["does-not-exist"] },
    { content: "fact missing the field entirely" },
  ];
  const { kept, dropped } = filterGrounded(records, new Map());
  assert.strictEqual(kept.length, 3);
  assert.strictEqual(dropped.length, 0);
});

test("significantTokens is NFKC + diacritic-preserving", () => {
  const toks = significantTokens("Tiếng Việt và TypeScript");
  assert.ok(toks.includes("tiếng"), `expected 'tiếng' in ${JSON.stringify(toks)}`);
  assert.ok(toks.includes("việt"), `expected 'việt' in ${JSON.stringify(toks)}`);
  assert.ok(toks.includes("typescript"), `expected 'typescript' in ${JSON.stringify(toks)}`);
});
