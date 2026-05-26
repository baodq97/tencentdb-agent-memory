# Self-Consolidation Memory — Progress Log

## Architecture Decision (2025-05-26)

**Goal supersedes design spec.** Building the component list from the goal (scripts + hooks + commands + skill), not the multi-agent orchestrator pipeline from the design spec. Spec will be updated as last step.

**Key pivot:** Agent hooks (`type: agent`) only have Read/Grep/Glob — no Write tool. SessionEnd is non-blocking. Therefore SessionEnd **cannot** do in-session L1 extraction via agent hook. Instead:

- **SessionEnd command hook**: Python script saves session metadata to `state.json` as `"pending"`. No extraction at this stage — L1 atoms are not available until the user runs `/memory-seed`.
- **Deferred empirical test**: Agent hook `type: agent` Write capability was verified via official docs (Read/Grep/Glob only), not empirical probe. The probe requires a session restart.
- **`/memory-seed`**: Agent-driven (Claude does the reasoning) — reads pending sessions from state.json, processes JSONL transcripts, extracts L1 atoms with LLM-quality reasoning, writes to records/*.jsonl + FTS5.
- **`/memory-consolidate`**: Agent-driven — groups L1 atoms into L2 scene blocks, generates L3 persona.md.
- **UserPromptSubmit hook**: Local FTS5 recall (fallback alongside existing Gateway recall). < 300 tokens, < 5s.

## Verified Facts

| Check | Result |
|-------|--------|
| FTS5 available on Windows Python | Yes — tested in-memory create + query |
| `~/.memory-tencentdb/` exists | No — clean slate, no Gateway conflict |
| Agent hook tools | Read, Grep, Glob only (no Write/Bash) |
| SessionEnd blocking | Non-blocking (fire-and-forget) |
| Agent hook timeout | 60s default |
| Command hook timeout | 600s default (UserPromptSubmit: 30s) |
| Claude project hash format | `D--2026-tencentdb-agent-memory` (path with `/`→`-`) |

## Component Status

| # | Component | Status | Notes |
|---|-----------|--------|-------|
| 1 | scripts/memory_store.js | Done | FTS5 storage engine — init, upsert, search, delete, count |
| 2 | scripts/memory_reader.js | Done | L0 JSONL parser — list projects/sessions, read messages, format for extraction |
| 3 | scripts/memory_writer.js | Done | Write L1/L2/L3 — JSONL + FTS5, scene blocks, persona, state.json |
| 4 | scripts/memory_recall.js | Done | FTS5 search + format — global+project merged, <300 token budget |
| 5 | hooks/hooks.json | Done | Existing format preserved (no changes needed) |
| 6 | hooks/scripts/on_session_end.js | Done | Gateway flush + local pending session save |
| 7 | commands/memory-consolidate.md | Done | Agent-driven L2 scenes + L3 persona |
| 8 | commands/memory-seed.md | Done | Agent-driven L1 backfill from old conversations |
| 9 | skills/memory-consolidation/SKILL.md | Done | Extraction skill with type/priority/scope rules |
| 10 | skills/memory-consolidation/references/extraction-guide.md | Done | Full extraction rules, examples, dedup guidance |

## Integration Test Results (2025-05-26)

All 10 checks passed:
- Scripts run standalone with --help
- FTS5 creates and queries correctly (global + project)
- L1 records match MemoryRecord schema (12 fields)
- Scene blocks have valid META header format
- Persona writes and reads correctly
- Recall < 1200 chars (budget: PASS)
- state.json tracks sessions and project timestamps
- L0 JSONL reads real Claude Code conversation data
- hooks.json validates with all 3 events
- SKILL.md has valid YAML frontmatter
