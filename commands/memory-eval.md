---
description: Run the plugin evaluation suite — automated checks, PersonaMem benchmark, and optional real transcript tests.
argument-hint: "[--real] [--section <1-7>] [--format json|text]"
allowed-tools: [Bash, Read, Agent]
---

Run the automated eval suite, then optionally invoke the memory-eval agent for real scenario testing.

## Automated Suite

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/eval_runner.js $ARGUMENTS
```

## Sections

| # | Section | What it tests |
|---|---------|---------------|
| 1 | Plugin Structure | Manifest, hooks.json, frontmatter, no .py files |
| 2 | JS Module Loading | All scripts require() and export correctly |
| 3 | FTS5 Storage | CRUD, search, type filter, update, delete |
| 4 | L0 Reader | Real JSONL transcripts, incremental, pairs |
| 5 | Writer + Schema | L1/L2/L3, MemoryRecord 12-field schema, META format |
| 6 | PersonaMem Benchmark | 10 facts, top-K recall, token budget |
| 7 | Real Transcripts | End-to-end with actual conversation data (use `--real`) |

## After automated checks

If there are failures, investigate each one. If all pass and the user wants deeper testing, invoke the **memory-eval agent** for real scenario testing (full pipeline, global vs project separation, incremental processing, edge cases).
