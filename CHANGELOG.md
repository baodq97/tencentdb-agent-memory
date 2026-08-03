# Changelog

All notable changes to this plugin are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Tiered L3 persona delivery (`scripts/persona_projection.js`).** The persona was delivered as `truncate(persona, 400)` — on a real 39,090-char / 81-bullet / 5-section persona that is 401 chars (1.03%), every one of them from `## Identity`, byte-identical on every turn, while the sections that actually govern behaviour (`Preferences`, `Working Style`, `Standing Instructions`) got nothing. Bullets are now classified by **duty** and delivered on the channel that duty needs: `always` → **tier 0**, injected once per session by the `SessionStart` hook as `<persona-core>`; `conditional` → **tier 1**, query-matched per turn inside `<memory-context>`; `reference` → **tier 2**, never injected, read on demand via `tmem persona --section <name>`. Tier 0 also carries a one-line index of *every* section name — including sections it delivered nothing from — because a progressive-disclosure pointer the agent doesn't know the targets of is unusable (same lesson as `<scene-navigation>`). The projection is pure and synchronous (one file read, no DB, no network), so the hook hot path stays inside its timeout, and it falls back to the previous exact output whenever the tiered projection comes back empty — never emit nothing where we used to emit something. Tests: `test/persona_projection.test.js`.
- **`tmem persona --sections` / `--section <name>`.** `--sections` lists each section with its bullet count and always/conditional/reference split (the tier-2 discovery surface); `--section <name>` prints one section verbatim, with prefix matching plus explicit ambiguous/missing errors.
- **`tmem config persona-max-tokens N`** — the tier-0 budget, env-overridable via `MEMORY_PERSONA_MAX_TOKENS`. Unlike `scene-max-tokens`, `0` is **rejected** rather than treated as "disable": an empty projection is indistinguishable from "no persona learned yet" on the agent's side, which is the exact failure this store exists to fix.
- **Memory visualiser (`tmem view`, `scripts/view/`, skill `memory-view`).** A live read-only lens on the store, built to answer one question — *does the agent actually know me?* — via a Context lens (which persona bullets reach the agent, on which tier) plus a Health strip. Every database handle is opened with `DatabaseSync(..., { readOnly: true })`, so "the visualiser never writes" is enforced by SQLite rather than by discipline. The server is session-keyed and the URL is required verbatim: the page renders raw auto-captured prompts from *every* project, so `localhost` alone is not a boundary. `--snapshot [--stdout]` exports the payload JSON once for before/after measurement, `--static` pins the numbers so they cannot move under a reader mid-measurement, `--root <dir>` reads another store. Session output goes to `<root>/view/`, never inside a repo. The CLI is the only entry point — `serve.js` is an internal module and the skill shells out to `tmem view` rather than reimplementing a metric or a route. Tests: `test/view_extract.test.js`, `test/view_transform.test.js`.

### Changed
- **Scene-navigation rendering extracted to one shared pure module (`scripts/scene_nav.js`).** `renderSceneNav(orderedScenes, maxChars)` — plus `NAV`, `heatEmoji`, `truncate`, `navLine`, `CHARS_PER_TOKEN` — now serves both callers. `memory_recall.buildSceneNav()` keeps what is genuinely its own: the filesystem reads, and the project-before-global ordering that decides who drops first under budget (a recall *policy*, not a rendering rule). The reason it had to move is the interesting part: `transform.js` carried a hand copy of the whole algorithm and five literals, because the pure view layer cannot import `memory_recall` — that would drag `MemoryStore`/`VectorStore` and `node:sqlite` into a module whose contract is that it does no I/O, which a test asserts. The copy was **already drifting**: `memory_recall`'s atom loops changed `break` → `continue` on this branch while the copied scene loop kept breaking. One renderer now means the deferred scene-nav fix is one edit in one place instead of two that can silently disagree. Behaviour-preserving, verified byte-identical against the previous implementation across 51 stores × 6 budgets (306 combinations, 0 mismatches, identical digests) — the scene loop's `break` semantics are reproduced verbatim, not improved.
- **`persona-max-tokens` default raised 300 → 1200.** This is affordable **only because tier 0 is paid once per session, not once per turn** — the per-turn channel is tier 1, whose budget (420 chars, ~105 tokens) was deliberately *not* widened. Anyone reading 1200 as a per-turn cost will "optimise" it back and silently restore the truncation this release exists to remove. At 300 tokens the projection reached 5 of 47 `always`-duty bullets, 4 of them cut mid-rule.
- **Tier 0 no longer truncates: a bullet is delivered whole or skipped.** `DEFAULT_BULLET_MAX_CHARS` (600) changed meaning for tier 0 from a truncation cap to an **eligibility threshold**, and the keep-ratio guard (`MIN_KEPT_RATIO`, `SHORT_SOURCE_CHARS`) is deleted. That guard was a proxy for "the operative clause survived", and it failed at its own job: a 1,145-char Standing Instructions bullet was delivered at 594 chars — 51.9%, comfortably over the 0.5 threshold — with its `Amended for orchard-flow only` carve-out cut away, so the agent received a **stricter rule than the user wrote**. Clause position does not correlate with bullet length, so no ratio can catch that. Measured after the change: **13 bullets delivered (was 12), 0 truncated (was 4)**, 4,673 of 4,800 chars, hook output 4,990 chars with zero ellipses. The cost is honest and stated: **11 of 47 `always` bullets exceed 600 chars and are now undeliverable** (that Standing Instructions bullet among them) — absent rather than misleading. `skills/memory-consolidate/SKILL.md` now instructs the writer accordingly: one rule per bullet, operative clause first. **Tier 1 still truncates**, deliberately — tier 1 is cover, tier 0 is contract.
- **The persona block no longer charges the L1 atom budget.** Recall billed the persona's ~425 chars against the same pool as the atoms, so up to 425 of a 1,120-char pool was spent before a single memory was considered. Tier 1 now has its own budget, the same convention `<scene-navigation>` already used.

### Fixed
- **The visualiser wrote to the store it was probing.** Its vector-capability probe constructed a `VectorStore`, whose constructor is a writer (`mkdirSync` → read-write `DatabaseSync` → `PRAGMA journal_mode=WAL` → `CREATE VIRTUAL TABLE IF NOT EXISTS l1_vec`). On a fixture in the "`vectors.db` exists but has no `l1_vec`" state, one `/api/recall` created `l1_vec` + 5 shadow tables + `vec_meta`, flipped the journal to WAL and left `-wal`/`-shm` behind — turning an honest `unmeasured` into a **manufactured `measured 0%`**, the exact false alarm the Source/Coverage machinery exists to prevent, caused by the tool that reports it. The probe is now stat-only (`listStores()` + the memoised `probeSqliteVec()`, neither of which opens a database), so SQLite is reached through exactly one path: `extract.openReadOnly()`.
- **`/api/recall` ignored `--root` and answered from the user's real store.** It calls the real `recallAsync()`, which resolves its own paths and takes no root argument — so pointing the viewer at a sanitised fixture still rendered the user's real prompts, and the Context lens silently described a different store than every other lens. The route now returns 409 when `--root` points away from the real store: refusing beats showing two stores at once.
- **The visualiser ignored `persona-max-tokens`.** A user who set it to 600 saw a lens drawing 12 delivered bullets while the hook delivered 6. Extraction now reads the same `getPersonaMaxTokens()` the `SessionStart` hook does, so the lens and the hook cannot disagree about the budget.
- **One oversized atom could suppress every lower-ranked atom behind it.** The budget loop `break`s on the first line that doesn't fit instead of skipping it, so a single 509-char atom could be the *only* memory injected out of five candidates while hundreds of chars of the pool went unspent. Now skips and continues; rank order is preserved for everything that fits.

### Known gaps
These are measured and recorded, not fixed — do not read this release as "persona delivery solved".
- **Tier 0 still reaches only 13 of 47 `always`-duty bullets** on the reference persona (up from 5); 34 do not arrive. The `always` class alone is ~22,000 source chars against a 4,800-char budget, so no budget setting closes it: it needs a *synthesised* core section produced on the consolidator side, which is deferred.
- **The recall path opens the store read-write, so a read can create schema.** `recall()` / `recallAsync()` construct `MemoryStore` — whose constructor builds the full FTS5 schema and writes `store_meta` unconditionally — and `VectorStore`, which creates `l1_vec` when the embed daemon returns a vector. A read path can therefore flip a store from an honest `unmeasured` to a manufactured `measured 0%`, the same class of defect fixed in the visualiser above. **Current exposure is 0 of 51 stores**: every live `index.db` already has its schema and is already WAL, and no store sits in the vulnerable "`vectors.db` present but schemaless" state. Reachable by initialising from a clone and then recalling from the installed plugin. Pre-existing, not introduced here; booked for a follow-up branch because the fix touches `memory_store.js` / `vector_store.js`, which this branch does not otherwise own.
- **A `vectors.db` can exist, open cleanly and contain zero embeddings.** The visualiser surfaced this for the first time: 22 of 51 stores (1,833 records) are in that state and silently fall back to FTS-only recall while passing every file-exists health check. Store-wide vector coverage is 37.5%. Reported as a `vectors_missing` gap with `tmem sync` as the remedy; the write path that lets it happen is not changed here.
- **The scene heat ladder has never rendered.** Scenes are written on a 1–5 scale (observed range 2–5 across 219 scenes) while `heatEmoji()` only emits flames at heat ≥ 50, so not one scene has ever shown a heat cue. Recorded as a `heat_scale_mismatch` gap; deliberately left alone, since picking a side changes either stored data or agent-visible output.

## [0.4.5] — 2026-07-31

### Added
- **Per-project recall toggle (`tmem config recall [on|off]`).** Disables the per-turn `<memory-context>` injection for a single project without touching capture or consolidation. The `UserPromptSubmit` hook now checks a per-project flag (`projects.<root-hash>.recall` in `state.json`) via a lightweight `isRecallDisabled()` reader on the hot path and returns nothing when recall is off; ingest (`on_stop` capture) and consolidation (`memory_pipeline` → memory-consolidator agent) are independent Stop-hook paths and keep running. The flag is **additive and fail-open** — projects without it (i.e. every existing store) keep recall ON, so there is no migration and no behavior change on upgrade. Manual `tmem recall "<query>"` still works regardless; only the automatic injection is gated. Toggle is scoped to the project root, exposed under the `tmem config` surface (no clash with the existing `tmem recall <query>` command), and documented in the `tmem-cli` skill. Tests: `test/recall_toggle.test.js`.

### Changed
- **Skill descriptions trimmed to cut always-on context (~1,020 → ~320 tokens across the 7 skills).** Skill descriptions load into every session, so long trigger lists were a recurring cost. `contrib-profile` (the orchestrator) and `tmem-cli` (the primary agent-facing skill) keep concise auto-trigger descriptions; the internal contrib phases (`contrib-ingest`, `contrib-consolidate`, `contrib-synthesize`) are now `user-invocable: false` — hidden from the `/` menu and never auto-triggered, while the orchestrator still invokes them by name; `memory-consolidate` keeps its now-minimal description (the memory-consolidator agent invokes it by name). No skill bodies or logic changed — only frontmatter descriptions and invocation flags.
- **`memory-seed` set to `disable-model-invocation: true`.** It is a human-triggered `/memory-seed` workflow that nothing invokes programmatically, so its description is dropped from context entirely; run it manually.

### Security
- **Bump `tar` 7.5.16 → 7.5.22 (Dependabot #9).** Pulls in upstream hardening against unbounded list recursion and explosive decompression (`maxDecompressionRatio` guard), plus safer unzip teardown on abort. Transitive dependency — lockfile only.

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
