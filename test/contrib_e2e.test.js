"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ContribStore } = require("../scripts/contrib_store.js");
const { addSubject, loadConfig } = require("../scripts/contrib_config.js");

test("deterministic pipeline: config -> atoms -> personas -> L4", () => {
  const gDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  addSubject(gDir, { github_user: "mitchellh", repo: "ghostty-org/ghostty" });
  addSubject(gDir, { github_user: "baodq97", repo: "baodq97/govkit" });
  const cfg = loadConfig(gDir);
  assert.strictEqual(cfg.subjects.length, 2);

  const store = new ContribStore(path.join(gDir, "contributors", "index.db"));
  for (const s of cfg.subjects) {
    store.upsertAtom({ record_id: `${s.id}:plan:1`, subject_id: s.id, dimension: "plan", content: "small PRs", evidence: ["PR#1"] });
    store.upsertPersona({ subject_id: s.id, dimensions: { plan: "small PRs" }, notable_traits: [] });
  }
  const caps = store.computeL4(cfg.l4.prevalence_threshold);
  assert.ok(caps.find((c) => c.capability === "plan"));
  assert.strictEqual(caps.find((c) => c.capability === "plan").summary, "2/2 subjects");
});
