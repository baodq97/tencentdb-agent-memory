---
name: tmem-cli
description: Inspect/manage the local memory store via the tmem CLI — counts, keyword/hybrid search, view persona, list/open scenes (tmem scene <name>), recent changes, sync vectors, thresholds, and cross-project search (tmem search <q> --all, tmem projects). Trigger on "how many memories", "show my persona", "what scenes exist", "search memories for X", "search across all projects".
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

## Cross-project memory

Each project keys its own store by the project **root** (the nearest `.git` ancestor; a
subdir or linked worktree maps to the SAME store). Recall and default `search` see only the
current project + global. To explore memory ACROSS projects by hand:

```bash
tmem projects                       # discover every store: slug, #records, #scenes ( * = current )
tmem search "<query>" --all         # search them all at once, grouped by store
tmem search "<query>" --project <slug>   # target one other project's store
```

If `tmem projects` shows many near-duplicate slugs that are subdirs/worktrees of one repo
(legacy fragmentation from before root-keying), collapse them with `tmem migrate-fragments`
(dry-run first, then `--apply`).

## Read / Inspect

| Command | When to use |
|---------|-------------|
| `tmem status` | Overview: record counts, vector counts, persona, scenes, capture state |
| `tmem doctor [--all] [--json]` | Health verdict + ranked fix plan (same metrics as the visualiser); `--all` = every store, `--json` = machine-readable plan for an agent |
| `tmem doctor --fix [--apply]` | Apply the auto-fixable set (idempotent, e.g. embed vectors); `--apply` also runs confirm-tier prune/dedup (archived); manual fixes are surfaced only |
| `tmem recall "<query>"` | Full hybrid recall + scene-navigation — same as what the hook injects each turn |
| `tmem search "<query>"` | Find memories by keyword (FTS5) in global + current project |
| `tmem search "<query>" --all` | Cross-project: search EVERY project store, grouped + labelled by store |
| `tmem search "<query>" --project <slug>` | Search global + one named project store (slug from `tmem projects`) |
| `tmem projects` | List every memory store (slug, #records, #scenes), `*` marks the current project |
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
| `tmem migrate-fragments [--apply]` | Collapse legacy cwd-keyed fragment stores into their project root. Dry-run by default; `--apply` merges records (id-deduped) + scenes (newer wins) and ARCHIVES each fragment under `<base>/.migrated/`. Run `tmem sync` afterwards to embed moved records. |
| `tmem sync [--full] [--all]` | Embed missing vectors (delta); `--full` re-embeds all; `--all` covers every store, not just current+global |
| `tmem prune --low-signal [--all] [--apply]` | Remove noise records (taskNotification/skillEcho/empty only — the safe gate classes). Dry-run unless `--apply`; archives under each store's `.pruned/` |
| `tmem dedup --atoms [--all] [--apply]` | Remove exact-duplicate atoms, keep the newest of each group. Dry-run unless `--apply`; archives under `.pruned/` |
| `tmem config` | Show effective config + stored values + env overrides |
| `tmem config consolidate-every [N]` | Get/set consolidation threshold (default 20) |
| `tmem config scene-max-tokens [N]` | Get/set scene-navigation token budget (default 200; `0` disables) |
| `tmem config recall [on\|off]` | Per-project: get/set whether the UserPromptSubmit hook injects memory context. `off` stops the per-turn `<memory-context>` for THIS project only; ingest + consolidate keep running. Default: on. |
| `tmem daemon status` | Health-ping the resident embed daemon → ready/warming/failed/stuck/down + pid (use when vector recall seems cold) |
| `tmem daemon start` | Warm + serve the embed daemon in the foreground (like `ollama serve`); keeps vector recall hot |
| `tmem daemon stop` | Stop the daemon + clear its pidfile (recovery: `status` → `stop` → `start`) |
| `tmem mark-done` | Mark consolidation complete + release lock |
| `tmem init` | Initialize memory store (normally via `/memory-init`) |

## Disable per-turn context injection (per project)

To stop the memory hook from injecting `<memory-context>` into the main thread every
turn for the current project — while STILL capturing turns and consolidating in the
background:

```bash
tmem config recall off      # this project: hook injects nothing; ingest + consolidate unaffected
tmem config recall on       # re-enable (default)
tmem config recall          # show current state (on/off)
```

The flag is stored per project-root in `state.json` (`projects.<hash>.recall`). It's
additive and fail-open: projects without the flag keep recall ON, so existing stores are
unaffected. Manual `tmem recall "<query>"` still works regardless — only the automatic
per-turn injection is gated.

## Which binary runs?

`tmem` is symlinked to the **installed** plugin (the Claude Code cache), so it always runs the
released code — correct for normal use. When developing this repo, uncommitted changes are NOT
picked up by `tmem`; run the repo copy directly instead:

```bash
node ./scripts/cli.js <command>            # repo working copy (dev)
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js <command>   # explicit installed path / PATH fallback
```

The CLI is **also published to npm** as `@baodq97/tmem` (CLI-only, no plugin
assets). To run it standalone — no plugin, no checkout — use `npx @baodq97/tmem
<command>` or `npm i -g @baodq97/tmem`; either provides the `tmem` command
(requires Node ≥ 24). The launcher self-resolves in this order: `$CLAUDE_PLUGIN_ROOT`
→ newest plugin cache → the `cli.js` sitting next to it (the npm-global case).

- `tmem version` — print the resolved version + the actual `cli.js` path + node
  version (use this to diagnose which copy is running; alias `--version`, `-v`).
- `tmem update` — check npm for a newer `@baodq97/tmem`; `--apply` runs the global
  install. Fail-open: offline just prints a soft note.
