# Changelog

All notable changes to this plugin are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); this project adheres to [Semantic Versioning](https://semver.org/).

## [0.4.4] — 2026-06-29

### Fixed
- **Memory recall fragmented per working directory.** Each project store was keyed by the full `cwd` slug with no project-root normalization, so launching Claude from a subdirectory, a linked worktree, a `.venv`, or `.claude/skills` created a SEPARATE store — and recall (which reads only the current cwd's store) silently missed memories written elsewhere. On a real repo this stranded ~30 scenes across 47 fragment stores. `projectHashForCwd` now resolves to the project root (nearest `.git`; a linked worktree follows its `gitdir:` to the MAIN repo root) before slugifying, with a fallback to the raw-path slug for non-git dirs (preserves existing behavior). All hook entry points + the CLI funnel through this one function, so the fix is global. Regression test: `test/project_root_keying.test.js`.

### Added
- **Cross-project memory exploration (manual CLI).** `tmem projects` lists every memory store (slug, #records, #scenes, `*` = current). `tmem search <q> --all` searches every project store at once, grouped + labelled by store; `tmem search <q> --project <slug>` targets one. Recall and default `search` stay single-project — cross-project is opt-in so the per-prompt recall hook is never polluted. Tests: `test/cross_project_search.test.js`.
- **`tmem migrate-fragments [--apply]`** — one-time cleanup that collapses legacy cwd-keyed fragment stores into their project root. Resolves each store's root via filesystem probe (longest-match handles dash-ambiguous dir names) and recovers deleted-dir fragments by prefixing against verified git roots only (never dumps orphans into a generic non-git dir). Records are id-deduped (idempotent), scenes keep the newer on name clash, and every fragment is ARCHIVED under `<base>/.migrated/` (never deleted). Dry-run by default. Tests: `test/migrate_fragments.test.js`.
- **SessionStart fragmentation hint.** When the current project has legacy fragment stores, the SessionStart hook surfaces a one-line note so the user can run `tmem migrate-fragments`. Detection is cheap (slug-prefix compare, no filesystem probing) and best-effort; it deliberately does NOT auto-merge — the destructive consolidation stays user-triggered. Tests: `test/session_start_hint.test.js`.

## [0.4.3] — 2026-06-29

### Fixed
- **`tmem` could silently run an outdated plugin version after an update.** The global `tmem` binary was a static shim pointing at one version dir; if it wasn't re-linked after a plugin update (or a hand-written shim shadowed it), `tmem` kept executing stale code while Claude Code loaded the new version — e.g. the 0.4.2 Vietnamese-recall fix appeared dead because `tmem` still ran 0.2.3. The plugin's own hooks were unaffected (they already invoke `${CLAUDE_PLUGIN_ROOT}/...`).

### Added
- **Version-independent `tmem` launcher (`scripts/tmem.js`).** Resolves the cli at runtime: prefers the version Claude Code loaded (`$CLAUDE_PLUGIN_ROOT`), else the newest installed version in the plugin cache, else a sibling `cli.js`. A stale copy of the launcher self-corrects. `bin.tmem` now points at the launcher, and `/memory-init` installs it to `~/.local/bin` to override any stale shim.
- **Version-drift warning in the cli.** When `tmem` runs a different version than the loaded plugin (`$CLAUDE_PLUGIN_ROOT`), it prints a one-line stderr warning suggesting `/memory-init` — a backstop for the rare case the launcher resolves to a non-loaded version.
- **Zero-touch self-heal on SessionStart.** A new SessionStart hook keeps `~/.local/bin/tmem` pointing at the current launcher with no user action. It is idempotent and safe: it installs the shim when missing, refreshes a stale shim of ours, and **never overwrites a foreign file** the user owns (recognized by content signature). Fully best-effort — any failure is swallowed so it can't disrupt a session.

## [0.4.2] — 2026-06-29

### Fixed
- **Vietnamese (and all non-ASCII) recall was silently broken.** `toFtsQuery` built the FTS5 MATCH with an ASCII `\w` class, which stripped diacritics from query terms (`"tiếng"` → `"ting"`, `"Việt"` → `"Vit"`), so queries matched nothing. On a real store this meant ~88% of Vietnamese memories were unrecallable by their own keywords (global 1/7, project 3/27 recalled). Now NFKC-normalizes and keeps Unicode letters/numbers (`\p{L}\p{N}`); recall went to 34/34 (100%) on the same store. Each token stays quoted, so FTS5 operators (`AND`/`OR`/`NOT`/`NEAR`) and special characters remain literals — no injection or query-breakage regression.
- **`eval_runner.js` Section 8 destroyed real user memories.** The auto-capture eval ran against the real `~/.memory-tencentdb` store and its "cleanup" deleted every `ac_`/`auto-capture` record — indistinguishable from a user's real captured memories. It now isolates the entire section in a throwaway home (overriding both `$HOME` and `$USERPROFILE` for POSIX/Windows) with a deterministic `MEMORY_CONSOLIDATE_EVERY`, restores env in `finally`, and removes the destructive delete + JSONL surgery. Regression test added (`test/eval_isolation.test.js`).

### Added
- **L1 grounding gate (`scripts/grounding.js`).** `tmem write-l1 --session` now drops agent-extracted atoms whose content isn't grounded in their cited source messages (token-set overlap, Unicode-aware, no LLM). Graceful: atoms with empty/unresolvable `source_message_ids` are kept, preserving backward compatibility. `memory-seed` skill updated to cite real transcript uuids.
- **Priority-cap rule in `memory-consolidate`.** Merging atoms must not inflate a memory's priority beyond the strongest contributing source.

## [0.4.1] — 2026-06-18

### Fixed
- **L4 prevalence no longer counts `"insufficient data"` as a present dimension.** `computeL4` filtered dimensions by non-empty string, so the persona-guide's `"insufficient data"` sentinel (an *unevidenced* dimension) was counted as present — inflating every capability toward 100% and collapsing the signal L4 exists to provide. Found by dogfooding a 6-member team where `mentor` showed 100% despite only 1/6 having any review-mentoring signal. The "present" predicate now excludes the `^insufficient` sentinel; prevalence reflects real evidence.

## [0.4.0] — 2026-06-18

### Added
- **`contrib-profile` orchestrator skill** — a one-shot front door to Contributor Intelligence. The user drops a GitHub profile/repo URL (or a handle) and the agent resolves the target (picking the right code repo via `gh` when only a user is given, skipping forks/awesome-lists) and runs the whole pipeline A→Z (add → ingest → build → playbook), or guides the user through it on request. Pure orchestration over the existing per-phase skills + CLI — no new runtime code. README gains a "just drop a link" quickstart.

## [0.3.0] — 2026-06-18

### Added
- **Contributor Intelligence (`/contrib`, `tmem contrib`)** — a new, fully-isolated feature that profiles how a GitHub engineer works and turns it into something a learner can act on. Ingests a subject's public activity via `gh` (author-scoped PRs, cross-branch commits, review threads given & received, issues; bot/fork/generated-file filtering; bounded rate-limit retry; incremental cursor) and classifies it into **11 dimensions across 3 clusters** — Technical Craft (`idea/plan/solve/craft`), Collaboration & Influence (`comms/mentor/conflict`), Outcomes & Ownership (`scope/ownership/execution`) — as evidence-linked atoms.
- **Personas & synthesis** — `build` consolidates atoms into a per-subject L3 persona; `capabilities` computes a deterministic **L4 capability model** (what the profiled engineers share); `playbook` distils a persona into emulable heuristics; `compare <id>` runs a you-vs-role-model gap analysis against your *existing* self-persona (no GitHub self-ingest); `compare <a> <b>` gives a deterministic two-contributor table; `trajectory` shows per-year cadence/style evolution; `team` aggregates a capability model across members.
- **Storage & recall** — separate store at `memory/contributors/` (FTS5 + optional vector RRF via the existing embed daemon); `search`, `personas`, `atoms` for inspection. The existing self-memory feature and its recall hooks are never touched (regression-guarded by a test).
- Three skills (`contrib-ingest`, `contrib-consolidate`, `contrib-synthesize`) with `references/` rubrics for classification, persona-building, and synthesis. 24 offline tests.

## [0.2.3] — 2026-05-29

### Added
- **`tmem daemon <start|status|stop>`** — explicit lifecycle control for the resident embed daemon. `start` warms EmbeddingGemma and serves in the foreground (like `ollama serve`); `status` health-pings and reports ready/warming/failed/stuck/down + pid; `stop` kills the daemon and clears its pidfile. Gives a deterministic recovery path (`status` → `stop` → `start`) when a daemon gets into a stuck state.

### Changed
- Embed-client round-trip timeout raised **200 ms → 500 ms** (`embed_client.js`). Warm round-trips measure ~70 ms median, but the first call after idle can spike to ~280 ms; 500 ms keeps that turn on vectors instead of falling back to FTS, while a down daemon still fails fast via `ENOENT` (no added latency when absent).

## [0.2.2] — 2026-05-29

### Added
- **L2 scene-navigation in recall** (progressive disclosure): each turn, recall injects a heat-ranked `<scene-navigation>` index of scene blocks (name + heat + summary), project scenes first then global. Full content is loaded on demand, not inlined.
- `tmem scene <name>` — print one full scene block by name (resolves project-first, then global).
- `tmem config scene-max-tokens [N]` — configure the scene-navigation token budget (default 200; `0` disables). Independent of the L1 atoms budget.
- **Resident embed daemon** (`embed_client.js` / `embed_daemon.js`): an embed-only daemon that keeps the EmbeddingGemma model warm over local IPC (named pipe on Windows, unix socket on POSIX), version-keyed and idle-exiting. Falls back to FTS-only on any failure.

### Changed
- `tmem config consolidate-every [N]` now configurable; default consolidation threshold raised to **20** turns.
- Hook latency fix in `hooks/scripts/_common.js` — `readHookInputAsync` settles once, clears its timeout, and unrefs it (removes a multi-second dangling-timer stall per turn).

### Fixed
- `tmem reindex` removed; folded into `tmem sync --full` (delta sync by default, `--full` rebuilds the whole index from FTS5).

## [0.2.1] — 2026-05-26

### Fixed
- Keep the leading dash in `projectHashForCwd` for WSL path compatibility.
- Correct marketplace source path (`./`) and simplify `plugin.json` for standalone install.

### Added
- Marketplace installation instructions in the README.

## [0.2.0] — 2026-05-26

### Added
- **Local embedding + hybrid recall**: vector search via EmbeddingGemma-300m (`node-llama-cpp`) and sqlite-vec, merged with FTS5 keyword results using Reciprocal Rank Fusion (RRF, k=60).
- `tmem` CLI surface and refreshed README/components.

### Changed
- Plugin structure refactor.

## [0.1.0] — 2026-05-17

### Added
- Initial Claude Code plugin port of [Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory): four-layer memory (L0 Conversation → L1 Atom → L2 Scene → L3 Persona), FTS5 keyword recall, agent-driven extraction/consolidation, fully local (no external Gateway, no paid API, no Python).

[0.2.3]: https://github.com/baodq97/tencentdb-agent-memory/releases/tag/v0.2.3
[0.2.2]: https://github.com/baodq97/tencentdb-agent-memory/releases/tag/v0.2.2
[0.2.1]: https://github.com/baodq97/tencentdb-agent-memory/releases/tag/v0.2.1
[0.2.0]: https://github.com/baodq97/tencentdb-agent-memory/releases/tag/v0.2.0
[0.1.0]: https://github.com/baodq97/tencentdb-agent-memory/releases/tag/v0.1.0
