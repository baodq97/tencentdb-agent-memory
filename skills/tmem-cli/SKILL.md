---
name: tmem-cli
description: Use the tmem CLI to inspect and manage the local memory store — record/vector counts, keyword/hybrid search, view persona, list scenes, read one full scene block (tmem scene <name>), recent changes, sync vectors, configure thresholds. Trigger when the user asks "how many memories do I have", "show my persona", "what scenes exist", "search memories for X", "open that scene", "recent memory changes", or when you need to check memory state before/after an operation. Do NOT use for extracting or consolidating memories — those have dedicated skills.
---

# tmem CLI

`tmem` is the memory store's command-line tool. Run it via Bash.

## Most-used

```bash
tmem status                 # counts + persona + scenes + capture state at a glance
tmem recall "<query>"       # hybrid recall (FTS5 + vector + RRF) + L2 scene-navigation — exactly what the hook injects
tmem search "<query>"       # fast FTS5 keyword search (no vectors)
tmem scene <name>           # print ONE full scene block by name
tmem scenes list            # list scene blocks (name, heat, updated, summary)
tmem persona                # show the persona document
```

## Scene navigation → on-demand read (progressive disclosure)

Each turn, recall injects a `<scene-navigation>` block: a heat-ranked **index** of scene
blocks (name + heat + summary), project scenes first, then global. It does NOT inline full
scene content. When a summary looks relevant, load the full block with:

```bash
tmem scene <name>           # <name> is the index entry, e.g. implementation-progress
```

`tmem scene` resolves project-first, then global. Names also come from `tmem scenes list`.

## Read / Inspect

| Command | When to use |
|---------|-------------|
| `tmem status` | Overview: record counts, vector counts, persona, scenes, capture state |
| `tmem recall "<query>"` | Full hybrid recall + scene-navigation — same as what the hook injects each turn |
| `tmem search "<query>"` | Find specific memories by keyword (FTS5 only) |
| `tmem scene <name>` | Print one full scene block (project-first, then global) |
| `tmem scenes list` | List all scene blocks with metadata (heat, updated, summary) |
| `tmem persona` | Read the current persona document |
| `tmem changelog [--last N]` | The N most recent memory writes (default 20) |
| `tmem atoms [global\|project\|all]` | Dump raw L1 atoms as JSON — use sparingly, output can be large |

## Write / Manage

| Command | When to use |
|---------|-------------|
| `echo JSON \| tmem write-l1 --session ID` | Write extracted L1 atoms (used by memory-seed) |
| `echo CONTENT \| tmem write-scene --name N --summary S --heat H` | Write/update a scene block (used by memory-consolidate) |
| `echo CONTENT \| tmem write-persona` | Write persona (used by memory-consolidate) |
| `tmem scenes dedup [--dry-run]` | Find/remove duplicate scenes by keyword overlap |
| `tmem sync [--full]` | Embed missing vectors (delta); `--full` rebuilds the whole index from FTS5 |
| `tmem config` | Show effective config + stored values + env overrides |
| `tmem config consolidate-every [N]` | Get/set consolidation threshold (default 20) |
| `tmem config scene-max-tokens [N]` | Get/set scene-navigation token budget (default 200; `0` disables) |
| `tmem daemon status` | Health-ping the resident embed daemon → ready/warming/failed/stuck/down + pid (use when vector recall seems cold) |
| `tmem daemon start` | Warm + serve the embed daemon in the foreground (like `ollama serve`); keeps vector recall hot |
| `tmem daemon stop` | Stop the daemon + clear its pidfile (recovery: `status` → `stop` → `start`) |
| `tmem mark-done` | Mark consolidation complete + release lock |
| `tmem init` | Initialize memory store (normally via `/memory-init`) |

## Which binary runs?

`tmem` is symlinked to the **installed** plugin (the Claude Code cache), so it always runs the
released code — correct for normal use. When developing this repo, uncommitted changes are NOT
picked up by `tmem`; run the repo copy directly instead:

```bash
node ./scripts/cli.js <command>            # repo working copy (dev)
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js <command>   # explicit installed path / PATH fallback
```
