"use strict";
// Cross-store awareness: (GAP-5) find stores that captured memory but were never
// consolidated into scenes, and (promotion) find user-facts recurring across
// projects. Pure cores tested here; the fs wrappers read real stores.

const { test } = require("node:test");
const assert = require("node:assert");
const { classifyBlind, groupPersonaCandidates, normKey } = require("../scripts/cross_store.js");

test("classifyBlind picks episodic-with-no-scenes stores that have a resolvable path", () => {
  const stores = [
    { hash: "a", episodicCount: 41, sceneCount: 0, realPath: "/p/a" }, // blind, actionable
    { hash: "b", episodicCount: 8, sceneCount: 3, realPath: "/p/b" },  // has scenes → not blind
    { hash: "c", episodicCount: 20, sceneCount: 0, realPath: "" },     // no path → not actionable (deleted proj)
    { hash: "d", episodicCount: 2, sceneCount: 0, realPath: "/p/d" },  // below minAtoms
    { hash: "e", episodicCount: 10, sceneCount: 0, realPath: "/p/e" }, // blind, actionable
  ];
  const blind = classifyBlind(stores, { minAtoms: 5 });
  assert.deepStrictEqual(blind.map((b) => b.hash), ["a", "e"]); // sorted by atom count desc
  assert.strictEqual(blind[0].episodicCount, 41);
});

test("classifyBlind minAtoms default excludes tiny stores", () => {
  const stores = [{ hash: "a", episodicCount: 4, sceneCount: 0, realPath: "/p/a" }];
  assert.strictEqual(classifyBlind(stores).length, 0);       // default minAtoms=5
  assert.strictEqual(classifyBlind(stores, { minAtoms: 1 }).length, 1);
});

test("groupPersonaCandidates surfaces facts recurring across >=N distinct projects", () => {
  const atoms = [
    { hash: "p1", content: "User prefers pnpm over npm for all projects" },
    { hash: "p2", content: "User prefers pnpm over npm for all projects" }, // same fact, other project
    { hash: "p1", content: "User prefers pnpm over npm for all projects" }, // dup within p1 — still 1 project
    { hash: "p3", content: "one-off task detail specific to this repo only" },
    { hash: "p2", content: "gh switch to baodq97 account" },
    { hash: "p4", content: "gh switch to baodq97 account" },
  ];
  const cands = groupPersonaCandidates(atoms, { minProjects: 2 });
  assert.strictEqual(cands.length, 2);
  assert.strictEqual(cands[0].projects.length, 2);          // pnpm fact: p1+p2 (dup in p1 not double-counted)
  assert.ok(cands.some((c) => /pnpm/.test(c.sample)));
  assert.ok(cands.some((c) => /baodq97/.test(c.sample)));
  // a fact in only ONE project is not a global candidate
  assert.ok(!cands.some((c) => /one-off/.test(c.sample)));
});

test("groupPersonaCandidates ignores too-short bodies and normalizes punctuation/case", () => {
  assert.strictEqual(normKey("Use  pnpm, NOT npm!"), "use pnpm not npm");
  const atoms = [
    { hash: "p1", content: "ok" }, { hash: "p2", content: "ok" }, // too short
  ];
  assert.strictEqual(groupPersonaCandidates(atoms, { minProjects: 2 }).length, 0);
});
