---
name: memory-recall-tuning
description: Tune local FTS5 recall when it's too noisy, too sparse, or missing relevant memories. Covers topK, token budget, persona injection, FTS5 query behaviour, and priority ranking. Use when the user says "memory recall is wrong / off-topic / missing", "too many memories injected", "persona never updates", or wants better recall quality.
---

# Recall tuning

All tuning is done by editing the plugin's JS files or running commands. No external config file needed.

## Level 1 — common adjustments

| Knob | Location | Default | What it does |
|------|----------|---------|--------------|
| `topK` | `memory_recall.js:recall()` | `5` | Max L1 atoms returned per query |
| `DEFAULT_MAX_TOKENS` | `memory_recall.js` | `280` | Token budget for injected context |
| Persona lines | `memory_recall.js:getPersona()` | `5` | Max persona attributes injected |
| Priority | L1 atom `priority` field | `50-100` | Higher priority = ranked first in results |

## Level 2 — extraction quality

| Knob | Where to control | Effect |
|------|------------------|--------|
| Memory types | `/memory-seed` extraction | persona (50-100), episodic (60-100), instruction (70-100) |
| Scope routing | `/memory-seed` | persona+instruction → global, episodic → project |
| Consolidation frequency | `capture_state.json` | asyncRewake triggers after N auto-captured turns |
| Scene grouping | `/memory-consolidate` | How L1 atoms are grouped into L2 scenes |

## FTS5 search behaviour

FTS5 is **keyword-based**, not semantic. Important characteristics:

- Matches on word tokens, not meaning
- Query `"dark mode"` matches records containing "dark" OR "mode"
- Single-word queries are more precise than multi-word
- Special characters are stripped by `toFtsQuery()`
- Case insensitive

**When FTS5 misses:** The persona section always injects, catching facts that share no tokens with the query. This is by design — persona is the safety net.

## Diagnosis flow

1. **Nothing recalls.** Run `/memory-search <keyword>`. If empty: no L1 atoms match. Run `/memory-seed` or check if auto-capture has stored anything.
2. **Recall returns irrelevant atoms.** The query matched tokens that appear in unrelated memories. Solutions: write more specific memories, increase priority on important ones, reduce `topK`.
3. **Persona never updates.** Run `/memory-consolidate` manually. Check that persona-type L1 atoms exist.
4. **Recall too slow.** The hook has an 8s timeout. FTS5 queries are sub-millisecond on normal DBs. If slow, the DB may be very large — check `index.db` file size.
5. **Too much context injected.** Lower `topK` or `DEFAULT_MAX_TOKENS` in `memory_recall.js`. The function auto-truncates at the budget.

## Improving recall quality

1. **Better seeding.** `/memory-seed` quality depends on conversation content. Rich technical discussions produce better atoms than quick Q&A.
2. **Manual memory addition.** Use `memory_writer.js write-l1` to add specific memories with high priority.
3. **Consolidation.** `/memory-consolidate` builds persona and scenes which improve recall coverage.
4. **Priority tuning.** Set higher priority (80-100) on frequently-needed facts during seeding.
