"use strict";
// Deterministic L0 → digest transform. The capture path today stores the user's
// prompt verbatim and discards the assistant response and every tool block —
// measured to drop ~91% of a session's durable facts. But the highest-signal,
// machine-CERTAIN facts (which files were edited, which commands ran, test
// pass/fail, git/release ops, versions) live in the tool blocks. This module
// parses them into a structured digest so the durable "what / where / result"
// is recovered by SOFTWARE (100% accurate, no LLM), leaving only the "why"
// (decision + rationale) for the consolidation LLM.
//
// PURE: entries in (already-parsed JSONL objects), digest out. No fs, no LLM.

const crypto = require("node:crypto");

const RELEASE_VER = /\bv?(\d+\.\d+\.\d+)\b/;

// Which tool_use names edit a file, and where the path lives on their input.
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

function basename(p) {
  return String(p || "").replace(/[?#].*$/, "").replace(/.*[/\\]/, "");
}

// Pull the text of a tool_result block (content may be a string or block array).
function resultText(block) {
  if (!block) return "";
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && b.type === "text" ? b.text : "")).join(" ");
  return "";
}

// Classify a Bash command + its result into a durable op, or null.
function classifyBash(command, result) {
  const cmd = String(command || "");
  const out = String(result || "");

  // Test run → pass/fail from `node --test` summary (`# pass N` / `# fail N`).
  if (/\bnode\s+--test\b|\bnpm\s+(run\s+)?test\b|--test\b/.test(cmd)) {
    // node --test prints the summary as `# pass N` (TAP) or `ℹ pass N` (spec);
    // accept either prefix so the pass/fail count is not silently dropped.
    const pass = (out.match(/(?:#|ℹ)\s*pass\s+(\d+)/) || [])[1];
    const fail = (out.match(/(?:#|ℹ)\s*fail\s+(\d+)/) || [])[1];
    if (pass != null || fail != null) {
      return { kind: "test", text: `tests: ${pass || "?"} pass, ${fail || "0"} fail` };
    }
    return { kind: "test", text: "ran test suite" };
  }
  // Release / version ops carry a concrete version — high signal, low noise.
  let m;
  if ((m = cmd.match(/gh\s+release\s+create\s+v?(\d+\.\d+\.\d+)/)))
    return { kind: "release", text: `GitHub release v${m[1]}`, version: m[1] };
  if ((m = cmd.match(/git\s+tag\s+.*v?(\d+\.\d+\.\d+)/)))
    return { kind: "release", text: `git tag v${m[1]}`, version: m[1] };
  if (/npm\s+publish\b/.test(cmd)) {
    const v = (out.match(RELEASE_VER) || [])[1];
    return { kind: "release", text: v ? `npm publish ${v}` : "npm publish", version: v };
  }
  if ((m = cmd.match(/gh\s+pr\s+(create|merge|view|close)/))) return { kind: "git", text: `gh pr ${m[1]}` };
  if (/git\s+commit\b/.test(cmd)) return { kind: "git", text: "git commit" };
  if (/git\s+merge\b/.test(cmd)) return { kind: "git", text: "git merge" };
  return null;
}

/**
 * Transform parsed transcript entries into a structured session digest.
 * @param {Array<object>} entries parsed JSONL objects (each with type + message)
 * @returns {{
 *   turns: number, userTurns: number, assistantTurns: number,
 *   filesEdited: string[], testRuns: string[], gitOps: string[],
 *   releases: string[], events: Array<{kind:string,text:string}>
 * }}
 */
function digestSession(entries) {
  const list = Array.isArray(entries) ? entries : [];

  // 1) map tool_use_id → result text (results arrive in the following user turn)
  const resultById = new Map();
  for (const e of list) {
    const c = e && e.message && e.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b && b.type === "tool_result" && b.tool_use_id) resultById.set(b.tool_use_id, resultText(b));
    }
  }

  const filesEdited = new Set();
  const events = [];
  let userTurns = 0, assistantTurns = 0;

  for (const e of list) {
    const type = e && e.type;
    const c = e && e.message && e.message.content;
    if (type === "user" && (typeof c === "string" || (Array.isArray(c) && c.some((b) => b.type === "text")))) userTurns++;
    if (type === "assistant") assistantTurns++;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || b.type !== "tool_use") continue;
      if (EDIT_TOOLS.has(b.name)) {
        const f = basename(b.input && b.input.file_path);
        if (f) filesEdited.add(f);
      } else if (b.name === "Bash" && b.input && b.input.command) {
        const op = classifyBash(b.input.command, resultById.get(b.id));
        if (op) events.push(op);
      }
    }
  }

  // de-dup events by text, keep order
  const seen = new Set();
  const uniqEvents = [];
  for (const ev of events) {
    if (seen.has(ev.text)) continue;
    seen.add(ev.text);
    uniqEvents.push(ev);
  }
  const releases = [...new Set(uniqEvents.filter((e) => e.kind === "release" && e.version).map((e) => e.version))];

  return {
    turns: userTurns + assistantTurns,
    userTurns,
    assistantTurns,
    filesEdited: [...filesEdited],
    testRuns: uniqEvents.filter((e) => e.kind === "test").map((e) => e.text),
    gitOps: uniqEvents.filter((e) => e.kind === "git").map((e) => e.text),
    releases,
    events: uniqEvents,
  };
}

/**
 * Turn a digest into a small set of durable, outcome-bearing L1 atom bodies —
 * the "what / where / result" of a session, 100% accurate and LLM-free. These
 * REPLACE the prompt-echo atom the capture path stores today (measured 10%
 * outcome-bearing) with facts a future agent can actually use. The "why"
 * (decision + rationale) is added later by the consolidation LLM, which reads
 * these grounded facts instead of re-deriving them.
 *
 * @param {ReturnType<typeof digestSession>} digest
 * @param {{intent?: string}} [opts] intent = the user's prompt, for context
 * @returns {string[]} atom content strings (may be empty when nothing happened)
 */
function toAtomRecords(digest, opts = {}) {
  const d = digest || {};
  const out = [];
  const intent = String(opts.intent || "").trim();
  const prefix = intent ? `${intent.slice(0, 80)} — ` : "";

  // Each atom carries a STABLE slot `key`, not just content: a session's file
  // count / test result / git ops mutate as it grows ("edited 40 files" becomes
  // "42"), so keying identity on the slot lets a re-digest UPDATE the same row in
  // place instead of leaving a trail of stale count-variants. Releases are keyed
  // per-version (each is its own durable fact); the rest are single slots.
  if (Array.isArray(d.filesEdited) && d.filesEdited.length) {
    const shown = d.filesEdited.slice(0, 12).join(", ");
    const more = d.filesEdited.length > 12 ? ` +${d.filesEdited.length - 12} more` : "";
    out.push({ key: "files", content: `${prefix}edited ${d.filesEdited.length} file(s): ${shown}${more}` });
  }
  for (const v of d.releases || []) out.push({ key: `release:${v}`, content: `${prefix}released v${v}` });
  if (Array.isArray(d.testRuns) && d.testRuns.length) {
    out.push({ key: "test", content: `${prefix}${d.testRuns[d.testRuns.length - 1]}` }); // latest run
  }
  const gitOps = (d.gitOps || []).filter((g) => !/view$/.test(g));
  if (gitOps.length) out.push({ key: "git", content: `${prefix}${[...new Set(gitOps)].join(", ")}` });
  return out;
}

// Back-compat / display + tests: the atom bodies alone. The write path uses
// toAtomRecords for the slot key; a dry-run only needs the text.
function toAtoms(digest, opts = {}) {
  return toAtomRecords(digest, opts).map((r) => r.content);
}

/**
 * Deterministic identity for a digest atom. The digest is a pure function of the
 * session, so re-running it must NOT create duplicates — the atom's id is derived
 * from (sessionId, content) instead of being random. MemoryStore.upsert keys on
 * this id, so a second run UPDATES the same row (and the caller skips the jsonl
 * append), making `tmem digest --apply` safe to run every turn. This is GAP-2:
 * idempotency lives in the identity, not in a dedup pass after the fact.
 * @param {string} sessionId
 * @param {string} content
 * @returns {string} stable atom id like "digest-<16 hex>"
 */
function digestAtomId(sessionId, key) {
  const h = crypto.createHash("sha1").update(sessionId + " " + key).digest("hex");
  return `digest-${h.slice(0, 16)}`;
}

module.exports = { digestSession, toAtoms, toAtomRecords, classifyBash, basename, digestAtomId };
