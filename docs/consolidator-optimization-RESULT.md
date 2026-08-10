# RESULT — memory-consolidator optimization (pre-registered bars)

Bars written BEFORE measuring actuals. Do not move a bar because a number came close.

## Baseline (measured, n=59 real subagent transcripts, strict filter)

Filter = transcript executed `tmem write-scene|write-persona|mark-done`.

| metric | baseline |
|---|---|
| tool-calls / run (median) | 16 |
| tool-calls / run (p90) | 34 |
| output tokens / run (median) | ~8,700 |
| duration / run (median) | ~223 s |

Cost drivers (cheap ≤median vs expensive ≥p90):

| driver | cheap avg | exp avg | ratio |
|---|---|---|---|
| shellrepo (grep/find/cat/ls/sed into repo) | 0.2 | 7.7 | **38.6x** |
| statuslike (status/scenes/persona/changelog reads) | 3.1 | 5.9 | 1.9x |
| writescenes | 2.7 | 6.9 | 2.5x |
| Read tool | 1.0 | 1.1 | 1.2x (not a driver) |
| tmem search | 0.2 | 0.1 | negligible |

## Change

1. `tmem consolidate-context` — one call bundling status + scenes + atoms delta +
   persona + doctrine + changelog (was 5-6 separate calls).
2. Skill + agent: hard "atoms-only" boundary — no `grep/find/cat/ls/sed`, no repo
   source/doc reading, no filesystem exploration.
3. `tmem write-scenes` — batch scene write from one JSON array (was N heredocs).

## Pre-registered bars (measured on the SAME transcript-analysis script, on the
## next real consolidator runs after merge — observational)

| bar | target |
|---|---|
| median tool-calls / run | ≤ 10 (from 16) |
| shellrepo / run (p90) | 0 (skill forbids; any >0 = skill-adherence miss) |
| statuslike / run | ≤ 2 (consolidate-context + mark-done) |
| output tokens / run (median) | ≤ 7,000 (from ~8,700) |

Quality guard (must NOT regress): scenes/persona still pass the write-persona budget
gate and the 80-char summary / 160-char bullet rules; recall helpfulness unchanged.

## Actuals

TBD — fill in after N≥10 real consolidator runs on the new code, using the same
analysis over `~/.claude/projects/*/subagents/agent-*.jsonl`.
