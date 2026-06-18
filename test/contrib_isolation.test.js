"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ContribStore } = require("../scripts/contrib_store.js");

test("contrib store writes only under contributors/ — never the self index.db", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iso-"));
  // simulate the self-memory DB
  const selfDb = path.join(root, "index.db");
  fs.writeFileSync(selfDb, "SELF");
  const before = fs.readFileSync(selfDb, "utf8");

  const cs = new ContribStore(path.join(root, "contributors", "index.db"));
  cs.upsertAtom({ record_id: "a1", subject_id: "x@y", dimension: "plan", content: "c", evidence: [] });

  // self DB byte-for-byte unchanged; contributor data under contributors/
  assert.strictEqual(fs.readFileSync(selfDb, "utf8"), before);
  assert.ok(fs.existsSync(path.join(root, "contributors", "index.db")));
});
