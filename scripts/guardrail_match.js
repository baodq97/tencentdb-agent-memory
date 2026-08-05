#!/usr/bin/env node
/**
 * Guardrail matcher (WS3) — pure, deterministic, no LLM.
 *
 * The measured gap: 76% of errors happen >3 tool-calls after the prompt, when the
 * SessionStart persona is cold, and 42% of the late ones are catchable from the
 * pending command alone (e.g. `pkill -f serve.js` → the SIGTERM-144 anti-pattern).
 * A PreToolUse hook surfaces the relevant guardrail at the MOMENT of the call.
 *
 * This module is only the matcher. Guardrail atoms come from consolidation
 * (project-doctrine "Boundaries & Anti-patterns" / work_method rules); the hook
 * loads them and calls matchGuardrails(pendingCommand, atoms). Matching is a
 * token-overlap test on the action words, reusing the same significantTokens the
 * grounding gate uses so the two never drift.
 *
 * Exports:
 *   commandSignature(command)            -> Set<string>  (significant action tokens)
 *   matchGuardrails(command, atoms, opts) -> [{ atom, score }]  (most relevant first)
 */
"use strict";

const { significantTokens } = require("./grounding.js");

// Command noise words significantTokens does NOT already strip (the/and/with/for
// are in grounding.STOPWORDS, so listing them here would be dead entries). These
// are shell-specific fillers that carry no signal about WHICH guardrail applies.
const COMMAND_STOPWORDS = new Set(["sudo", "run", "then", "cd", "echo"]);

/** Significant action tokens of a shell command / tool input. */
function commandSignature(command) {
  const toks = significantTokens(String(command == null ? "" : command));
  const out = new Set();
  for (const t of toks) if (!COMMAND_STOPWORDS.has(t)) out.add(t);
  return out;
}

/**
 * Match a pending command against guardrail atoms.
 *
 * @param command  the pending tool command / input string
 * @param atoms    [{ content, type?, scene_name?, metadata? }]
 * @param opts.threshold  min overlap ratio vs the SMALLER token set (default 0.3)
 * @param opts.max        cap on returned matches (default 3)
 * @returns [{ atom, score, shared }] sorted by score desc; [] if nothing matches.
 */
function matchGuardrails(command, atoms, opts = {}) {
  const threshold = opts.threshold ?? 0.3;
  const max = opts.max ?? 3;
  const cmdTokens = commandSignature(command);
  if (cmdTokens.size === 0 || !Array.isArray(atoms)) return [];

  const matches = [];
  for (const atom of atoms) {
    const atomTokens = commandSignature(atom && atom.content);
    if (atomTokens.size === 0) continue;
    let shared = 0;
    for (const t of atomTokens) if (cmdTokens.has(t)) shared++;
    if (shared === 0) continue;
    // Score against the SMALLER token set so a verbose guardrail sentence isn't
    // penalised: what matters is that the command's action words appear in the
    // guardrail (or vice-versa), not the guardrail's prose length.
    const score = shared / Math.min(cmdTokens.size, atomTokens.size);
    if (score >= threshold) matches.push({ atom, score, shared });
  }
  matches.sort((a, b) => b.score - a.score || b.shared - a.shared);
  return matches.slice(0, max);
}

module.exports = { commandSignature, matchGuardrails, COMMAND_STOPWORDS };
