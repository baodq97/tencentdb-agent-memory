"use strict";
// Remove the temp directories a test process created, when it exits.
//
// WHY THIS IS ONE FILE AND NOT 67 EDITS. Tests create scratch dirs with
// fs.mkdtempSync in 67 places across 37 files, and most — but not all — remove
// them in a finally. The ones that miss are not obviously wrong at the call site:
// a module-scope fixture has no finally to put the cleanup in, and a helper that
// throws skips its own. Measured, one `npm test` left 51 directories behind and
// /tmp had accumulated 1,413.
//
// Editing every call site would be 67 chances to break a green suite for a
// problem none of them individually owns. Instead this is imported once, via
// `node --test --import`, into every test process, and it records exactly what
// THAT process created.
//
// Scoping to the current process is the safety property. `node --test` runs test
// files in PARALLEL processes; a cleanup that swept /tmp by name or by timestamp
// would delete a sibling process's live fixture mid-run. It also never touches
// files — the embed daemon keeps its .pid/.sock in the same directory, and those
// belong to a process that outlives the suite.
const fs = require("node:fs");

const created = new Set();
const realMkdtempSync = fs.mkdtempSync;

fs.mkdtempSync = function (...args) {
  const dir = realMkdtempSync.apply(this, args);
  created.add(dir);
  return dir;
};

// `exit` only: a test that fails or throws must still clean up, and by then the
// process is going away regardless. Failures here are ignored — a cleanup that
// masks the real exit code would hide the result the suite exists to report.
process.on("exit", () => {
  for (const dir of created) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});
