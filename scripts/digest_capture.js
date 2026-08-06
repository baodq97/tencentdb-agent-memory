"use strict";
// GAP-1 (auto-wire) + GAP-2 (idempotency): the ONE orchestration that turns a
// transcript into durable, outcome-bearing L1 atoms and writes them idempotently.
// Both `tmem digest --apply` (CLI) and the Stop hook call this, so the capture
// path cannot drift between manual and automatic runs.
//
// Idempotency: each atom's id is a deterministic function of (sessionId, slot)
// (see digestAtomId). A re-run of the same session therefore resolves to the same
// ids — an id already present in the store is SKIPPED (no jsonl append, no dup),
// and a slot whose body changed ("40 files" → "42") is re-written under its stable
// id via upsert. So running this every turn converges instead of accumulating.

const fs = require("node:fs");
const path = require("node:path");

const SCRIPTS_DIR = __dirname;
function req(name) { return require(path.join(SCRIPTS_DIR, name)); }

// Parse a transcript .jsonl into entry objects. Tolerant: skips unparseable lines.
function readEntries(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  return fs.readFileSync(transcriptPath, "utf-8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Current stored body for each candidate id — read-only (one open), so it never
// perturbs the store. Missing db / open failure degrades to an empty map, i.e.
// "nothing stored yet", and everything is treated as new.
function storedBodies(baseDir, candidateIds) {
  const byId = new Map();
  try {
    const { MemoryStore } = req("memory_store.js");
    const dbPath = path.join(baseDir, "index.db");
    if (!fs.existsSync(dbPath)) return byId;
    const store = new MemoryStore(dbPath, { readOnly: true });
    for (const id of candidateIds) {
      try { const row = store.get(id); if (row) byId.set(id, row.content); } catch {}
    }
    store.close();
  } catch {}
  return byId;
}

/**
 * Digest a transcript and (optionally) write its outcome-atoms idempotently.
 *
 * @param {object} o
 * @param {Array<object>} [o.entries] pre-parsed entries (else read from path)
 * @param {string} [o.transcriptPath] transcript .jsonl to read when entries absent
 * @param {string} o.baseDir project store dir (…/projects/<hash>)
 * @param {string} o.sessionId session id (identity + provenance)
 * @param {string} [o.intent] the user's prompt, for atom context
 * @param {boolean} [o.apply=false] false = dry-run (compute only, write nothing)
 * @returns {{digest:object, atoms:Array<{key,content,id}>, written:number, skipped:number}}
 */
function captureDigest(o = {}) {
  const { digestSession, toAtomRecords, digestAtomId } = req("session_digest.js");
  const entries = o.entries || readEntries(o.transcriptPath);
  const digest = digestSession(entries);
  const sid = String(o.sessionId || "");
  const records = toAtomRecords(digest, { intent: o.intent || "" })
    .map((r) => ({ ...r, id: digestAtomId(sid, r.key) }));

  const result = { digest, atoms: records, written: 0, skipped: 0 };
  if (!o.apply || !records.length || !o.baseDir) return result;

  const { writeL1Record } = req("memory_writer.js");
  const stored = storedBodies(o.baseDir, records.map((r) => r.id));
  for (const r of records) {
    // Skip when the stored body for this id is already exactly this content: same
    // session + same slot + unchanged body → a pure no-op, so no jsonl append and
    // no re-embed. A changed body keeps the SAME id (slot-keyed) but a different
    // content, so it is NOT skipped — writeL1Record's upsert replaces in place.
    if (stored.get(r.id) === r.content) { result.skipped++; continue; }
    // Per-atom try/catch: a busy/locked store (a concurrent digest child) must not
    // abort the remaining slots. busy_timeout (memory_store) makes this rare; the
    // write is idempotent so a skipped atom is re-written on the next digest.
    try {
      writeL1Record(o.baseDir, {
        id: r.id,
        content: r.content,
        type: "semantic",          // survives keepDistilledAtoms → recallable per-turn
        priority: 55,
        scene_name: "session-digest",
        sessionId: sid,
        source_message_ids: [],
        metadata: { digest: true, session_id: sid, slot: r.key },
      });
      result.written++;
    } catch { result.skipped++; }
  }
  return result;
}

module.exports = { captureDigest, readEntries };
