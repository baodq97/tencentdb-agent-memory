#!/usr/bin/env node
/**
 * PreToolUse hook (WS3) — surface this repo's guardrails at the MOMENT of a tool
 * call, not at prompt start. Measured: 76% of errors happen >3 tool-calls after
 * the prompt (persona cold), and 42% of the late ones are catchable from the
 * pending command alone. This hook loads the project doctrine's "Boundaries &
 * Anti-patterns" / "Agent Rules" and warns (never blocks) when the pending Bash
 * command matches one.
 *
 * Fail-open and quiet: any error, no doctrine, or no match → emit {} (no context).
 */
"use strict";

const path = require("node:path");
const { addPluginScriptsToPath, readHookInputAsync, emit } = require("./_common.js");
const scriptsDir = addPluginScriptsToPath();

// Doctrine sections whose bullets are actionable guardrails to match commands on.
const GUARDRAIL_SECTION = /(anti-?pattern|boundaries|agent rules?)/i;

async function main() {
  const payload = await readHookInputAsync();
  try {
    // Only Bash commands carry a shell string to match; other tools are skipped.
    if ((payload.tool_name || "") !== "Bash") return emit({});
    const command = (payload.tool_input && payload.tool_input.command) || "";
    if (!command.trim()) return emit({});

    const { projectDir, readPersona } = require(path.join(scriptsDir, "memory_writer.js"));
    const { projectHashForCwd } = require(path.join(scriptsDir, "memory_reader.js"));
    const { parsePersona } = require(path.join(scriptsDir, "persona_projection.js"));
    const { matchGuardrails } = require(path.join(scriptsDir, "guardrail_match.js"));

    const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const hash = projectHashForCwd(cwd);
    if (!hash) return emit({});

    const doctrine = readPersona(projectDir(hash));
    if (!doctrine || !doctrine.trim()) return emit({});

    const atoms = [];
    for (const s of parsePersona(doctrine)) {
      if (!GUARDRAIL_SECTION.test(s.name || "")) continue;
      for (const b of s.bullets) atoms.push({ content: b.text });
    }
    if (!atoms.length) return emit({});

    const matches = matchGuardrails(command, atoms);
    if (!matches.length) return emit({});

    const body = matches.map((m) => `- ${m.atom.content}`).join("\n");
    return emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "<memory-guardrail>\nThis repo's doctrine warns about the command you are about to run:\n" +
          body +
          "\n</memory-guardrail>",
      },
    });
  } catch {
    return emit({});
  }
}

main().catch(() => { emit({}); process.exit(0); });
