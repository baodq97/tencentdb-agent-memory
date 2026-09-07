# Changelog

All notable changes to this plugin are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); this project adheres to [Semantic Versioning](https://semver.org/).

## [0.9.1] — 2026-09-07

Republishes 0.9.0, which never reached npm. `test/consolidate_lock_queue.test.js` stubbed
`spawnSyncFn` but not the PATH lookup, so `consolidate_runner`'s preflight short-circuited
to `skipped/no-claude-binary` before the lock check — every assertion in that file was
testing the preflight, green on a machine with Claude Code installed and red on a clean
runner. It failed the release workflow's `npm test`. `test/_fake_claude.js` exists for
exactly this failure and was written the last time it shipped (445 green locally, 7 CI
failures); the new file did not use it. Verified this time by running the whole suite with
every PATH entry containing a `claude` executable removed: 519 pass, 0 fail. No behaviour
below changed — v0.9.0 is a git tag with no npm artifact behind it.

## [0.9.0] — 2026-09-07

A MINOR bump, not a patch, and deliberately so: `tmem mark-done` no longer releases the
consolidation lock, the lock file gains fields, the view schema moves 6 -> 7, and
`tmem feedback --json`'s `coldAtoms`/`coldPct` keep their names while changing what they
count (recall-eligible atoms, not every record). A consumer of that JSON gets a different
number with no signal that anything moved, which is a breaking change however small the
diff that causes it.

Independent fixes: recall stops firing on the harness's own noise, `tmem doctor` denominates
reachability over the population that can actually be recalled instead of over everything
captured, a lock collision in consolidation is now visibly deferred instead of looking like a
loss — and consolidation's two lifecycle primitives, how-far-have-we-folded and the mutex,
move from the model's judgement to software, on BOTH the automatic and the manual path. The
boundary that restores: the LLM decides WHAT is worth folding, software decides HOW FAR has
been folded, and reclaiming the mutex requires proof that the previous holder's work — not
merely the process that wrote the lock file — is over.

### Added
- **A read-side gate on machine-generated turns.** `NOISE_GATE_CLASSES` in `low_signal.js`
  only ever gated the WRITE side — what auto-capture refuses to store. Nothing gated the
  QUERY side, so a `<task-notification>`, `<cross-session-message>`, or other
  harness-to-itself turn searched memory and injected it exactly like a human prompt would.
  Measured on the real recall log (2,658 turns, `recall_log.jsonl` + `.jsonl.1`,
  2026-09-04 -> 2026-09-07): 293 of 2,658 turns (11.0%) open with a machine prefix, yet
  they were injected on **66.9%** of turns versus **38.9%** for the 2,365 real user
  turns — nearly double the hit rate, because a notification is long and keyword-rich, not
  because it is a question anyone asked. `isMachineTurn()` (`scripts/low_signal.js`) is
  checked at the top of both `recall()` and `recallAsync()` in `scripts/memory_recall.js`;
  a matched turn still logs (empty `factIds`), so the effect stays measurable rather than
  becoming an invisible no-op.
- **`tmem doctor` and the view dashboard denominate reachability over the recall-eligible
  population, not episodic volume or all records.** Measured across 89 real stores: 5,713
  total L1 records, of which only 115 (2.0% — 96 semantic + 19 instruction) are
  vector-eligible; the rest (episodic, persona) are structurally unreachable by design, not
  broken. `scripts/memory_reachability.js` gained a pure
  `summarizeEligibleReachability(atoms, injectedIds)`; `scripts/view/transform.js` sums it
  per-store into a new `totals.reachability = {eligible, hot, cold, hotPct, episodicVolume,
  ineligibleVolume}` on the Snapshot (`hot`/`cold`/`hotPct` read `null`, not `0`, when the
  recall log itself is unmeasured). `tmem doctor`'s plain-text output and the view's tile
  row both print the eligible/hot percentage and the episodic count separately, with no
  percentage attached to the count. View schema bumped 6 -> 7.

### Fixed
- **Consolidation no longer marks atoms consolidated that nobody read.** The watermark was
  advanced by `tmem mark-done`, called by the model from inside the `claude -p` child, to
  `MAX(updated_time)` as of that moment — i.e. after the child had already read its atoms.
  Runs take a median of 69.0s and as long as 164.3s (all 17 records in
  `consolidation_runs.jsonl` carrying `duration_ms`, 2026-09-04 -> 2026-09-07; the median is
  quoted rather than a p95 because n=17 does not support a percentile to a tenth of a
  second — the maximum is the honest ceiling, and 11 of the 17 exceed 60s) and an active
  session keeps capturing throughout, so every atom written between the child's
  `atoms --since-last` and its `mark-done` was credited without ever being read. Measured in
  that same window by querying each run's own project store for `updated_time` inside
  `[at - duration_ms, at]`: **2 atoms across those 17 runs**, both episodic, both on
  2026-09-04, both in runs that exited 0 with verdict `changed` — small, because a write has
  to land inside the few minutes a run is actually in flight, but silent, permanent and
  unlogged when it does. `scripts/consolidate_runner.js` now cuts the cursor
  (`projectCursor(hash)`, one definition in `memory_writer.js`) BEFORE it spawns the child,
  passes it down as `TMEM_CONSOLIDATE_CURSOR`, and advances the watermark itself to exactly
  that value — on exit 0 only. A spawn error or non-zero exit does not advance (the same
  window is re-offered next run); a `no-op` verdict does, because "I read them and none were
  durable" is a successful outcome and not advancing would re-read a forever-growing window.
  `MemoryStore.recordsSince()` gained an `untilTs` upper bound, applied by `tmem atoms` and
  `tmem consolidate-context`, so the window that is read and the window that is credited are
  the same window. Each run record now carries `cursor` and `watermark_advanced`, so the log
  can answer "how far had we folded" after the fact. `setConsolidatedWatermark()` is also
  monotonic now: two paths write it, and an interleaving that let the older write land last
  would re-offer atoms already folded.

- **The cursor stops at the last atom a run can actually READ, not at the newest atom that
  exists.** A run reads at most 500 rows per store (`CONSOLIDATE_READ_LIMIT`, now one
  definition in `constants.js` instead of a bare `500` in each of `tmem atoms` and
  `tmem consolidate-context`), so advancing to `MAX(updated_time)` credited every atom past
  the 500th as consolidated without anything having read it — permanently, since the
  watermark had moved past them. Reproduced end to end: 600 seeded atoms, no watermark, one
  real `runConsolidation` — the child read `m_0000..m_0499`, the watermark advanced to
  `m_0599`, and the next `atoms --since-last` returned nothing. Reachable on the live store:
  one project (`-home-bd-projects-aiquinta-platform`) holds 1,967 records with no watermark,
  where the first run under the old rule would have credited 1,467 atoms nobody read.
  `MemoryStore.consolidationCursor(since, limit)` now returns the largest timestamp `B` for
  which `count(since < updated_time <= B) <= limit`, keeping same-timestamp groups whole, and
  `projectCursor()` is defined in terms of it.

- **The consolidation mutex is no longer opened by the model, and no longer released by
  whoever happens to call.** `tmem mark-done` unlinked the per-project lock file, so the lock
  was released by a language model's judgement about which step it was on: call it early and
  the store is unguarded for the rest of the run — minutes — long enough for another trigger
  to start a second consolidation on it, which is the race the move to headless dispatch was
  made to kill. `mark-done` no longer touches the lock; `consolidate_runner.js`'s
  `finally { releaseLock }` is the only release path for a run it started (it cannot run
  before the child exits, because `spawnSync` is synchronous). Because that finally now
  ALWAYS runs, `releaseLock()` had to stop being ownership-blind: it unlinked whatever was at
  the path, so a single reclaim or a manual `tmem unlock` mid-run did not degrade to one
  overlapping run but to an unguarded store — R1's finally deleting R2's live lock, R3
  starting beside R2, and so on. Each lock now carries a `token` (and an `owner`), and a
  release must be the creator's, or an entitled path's (`mark-done` may end a MANUAL lease
  and nothing else), or an explicit `force` — which is what `tmem unlock` is, and it now says
  when it has just unlocked a live run.

- **The manual consolidation path is guarded too — it had no mutual exclusion of any kind.**
  `/memory-seed` → the memory-consolidator agent → the memory-consolidate skill never took a
  lock and never checked one, so a `/memory-seed` typed while a background run was in flight
  (median 69s) read the store unbounded and wrote scenes and persona over the same files the
  runner's child was writing: two read-modify-write cycles, the later writer wins, neither
  ever observing the other. `tmem consolidate-context` — the skill's read phase, and the only
  point that spans an interactive run — now takes a short LEASE on the project store and
  returns `{busy:true}` (fold nothing, stop) when a runner holds it; `runConsolidation`
  refuses to start on a store the lease holds. A lease records no pid, because the `tmem`
  process that writes it exits at once while the agent keeps working, so it is judged by its
  own shorter TTL (15 min, `TMEM_MANUAL_LEASE_TTL_MS`) and ended early by `mark-done`.

- **The manual path's watermark is now cut at the READ, not recomputed at completion.**
  Defect (1) above was fixed for the automatic path only: a bare `tmem mark-done` still
  advanced the watermark to a live `MAX(updated_time)`, i.e. to "now", crediting whatever
  another session had captured while the agent was folding. The same discipline now applies
  with a different carrier: `consolidate-context` cuts the window and parks it in
  `state.json` (`pending_read_cursor`), `mark-done` spends it exactly once. A `mark-done`
  with no cut behind it moves the watermark **not at all** and says so — re-reading atoms is
  free, crediting unread ones is not. Which path a `mark-done` is on is decided by
  `TMEM_CONSOLIDATING`, not by the presence of the cursor: the cursor is legitimately empty
  when a store is empty or unreadable, and reading that absence as "no runner" is how
  advance-to-now survived inside the automatic path's own child for a store whose `index.db`
  was missing at cut time. `TMEM_CONSOLIDATING` is set on every child unconditionally.

- **A lock is reclaimed only on proof that the previous holder's work is over — which the
  writer's pid alone cannot give.** Staleness was time-only, justified by an architecture
  that no longer exists (the lock's writer was the Stop hook, which exits at once). Since
  consolidation moved to `consolidate_runner.js` the writer holds the lock across a
  synchronous `spawnSync`, so the recorded pid IS live for the guarded window — but the work
  is the `claude -p` GRANDCHILD, which survives its parent: SIGKILL the detached runner and
  that child is reparented to init and keeps folding the store, while a bare pid check reads
  "writer dead" and hands the mutex to a second consolidation. 11 of the 17 real runs exceed
  the 60s pid grace, so that window would have covered most of a typical run — strictly worse
  than the 30-minute TTL it replaced. The runner is spawned detached, so it leads its own
  process group and the child inherits it; the lock records that `pgid`, and an EMPTY process
  group — not a dead pid — is what proves a run is over. The ladder is now: younger than
  `TMEM_LOCK_PID_GRACE_MS` (60s) ⇒ live; recorded pid alive ⇒ live, and **the TTL does not
  override that** (reclaiming a provably-live holder is not self-healing, it is a second
  concurrent run); pid dead with an empty process group ⇒ reclaim at once instead of wedging
  the project for 30 minutes; anything else — an orphan still running, a lease with no pid, an
  unreadable lock — falls back to the TTL exactly as before. `isStale` is also pure now
  (renamed `staleReason`): it used to UNLINK from inside `isLocked`, so the "cheap read-only
  pre-check" was the thing that destroyed a live run's lock file; reclaiming happens only
  under the existing rename-claim protocol, where exactly one racer can act on the verdict.

- **A hung consolidation now has a clock.** Nothing bounded the `claude -p` child in time:
  `--max-turns` and `--max-budget-usd` are caps on work, and a child stalled in a network call
  satisfies both forever. That is only tolerable while a TTL can steal the lock from it, and
  it can no longer. `spawnSync` now gets a `timeout` DERIVED from `LOCK_TTL_MS` (20 min by
  default, `TMEM_CONSOLIDATE_TIMEOUT_MS`, always at least a minute under the TTL) rather than
  configured beside it, so "the run outlives its own lock" is unreachable by construction; a
  run killed that way is recorded with `timed_out: true` next to its `failed` verdict.

  SCOPE LIMIT: the three records that answer "how far have we folded" — the
  `last_consolidated` watermark, the cascade L1 marker, and `last_consolidation_turn` — are
  still three records; collapsing them is out of scope. Their write TIMING now moves apart on
  the automatic path (the counter and cascade marker are still written by the child's
  `mark-done`, the watermark by the runner after the child exits), and so do their VALUES for
  one bounded case: an atom captured mid-run is counted as folded by the counter and the
  cascade marker and deliberately excluded by the watermark. The consequence is a delay, not
  a loss — `planCascadeStep` skips while `currentL1 <= marker`, and the next captured turn
  moves the counter past it and re-arms dispatch — and it is strictly better than the silent
  credit it replaces. Previously all three were written by one call at one instant.

- **A session-end trigger that lost a consolidation lock race is no longer indistinguishable
  from a discarded run.** Measured against production log evidence
  (`-home-bd-projects-nag-pilot-req-01`, 2026-09-05): four session-end/locked skips
  (13:07-13:51) were followed at 14:36 by a counter-triggered run that absorbed the same
  backlog — nothing was actually lost, but the `consolidation_runs.jsonl` record for those
  four skips read identically to a true loss. The skip record now adds `retryable:true` and
  `turns_since_consolidation` (verdict/reason unchanged, so the pinned
  `test/project_lock.test.js` assertion still holds). Separately, `spawnDetachedRunner` —
  the choke point both the counter and session-end dispatchers call — now does a cheap
  `pipeline.isLocked(hash)` pre-check before spawning, closing the gap that let the
  session-end dispatcher spawn a doomed `claude` process on every collision (the counter
  arm already had an equivalent pre-filter in `memory_pipeline.js`; measured, all 9
  `reason:"locked"` records across 24 runs (2026-09-04 -> 2026-09-07) had
  `trigger:"session-end"`, zero `trigger:"counter"`). No new state file: the existing
  per-project counters (`capture_state.json`) are untouched by a lock miss, so the next
  natural trigger retries the same backlog.

- **`tmem doctor` and `tmem feedback` no longer print a second, contradicting denominator.**
  The reachability and feedback sections of both commands are rendered inline in
  `scripts/cli.js`, not through `doctor.js`'s `renderPlanText()`, so the fix above left one
  command printing the eligible-scoped percentage in its header and the old
  episodic-scoped one six lines below it — two numbers about the same store that disagree,
  neither naming the population it counted. `cmdDoctor`'s feedback line and `cmdFeedback`
  now both call `summarizeEligibleReachability()`; the episodic outcome ratio is still
  printed, but relabelled `capture quality (episodic — not recallable by design)` so it
  cannot be read as recall health. `tmem feedback --json` gains `eligibleAtoms` and
  `ineligibleAtoms`, and its existing `coldAtoms`/`coldPct` are now eligible-scoped.
  The advice this corrects was load-bearing: `tmem feedback` called every cold atom a
  "prune candidate" over a denominator that included the ~5.6k records `NON_RECALL_TYPES`
  excludes from recall by design — acting on it would have deleted the entire episodic
  capture layer to move a percentage that never measured recall. That line is now split in
  two, and the by-design population is explicitly marked NOT a prune candidate.

### Notes
- `scripts/recall_feedback.js`'s `classifyStoreAtoms()` is no longer called from production
  code (its hot/cold split over an unfiltered atom list is exactly the denominator this
  wave removed). It is still exported and still covered by `test/recall_feedback.test.js`;
  deleting it was left out of scope so this wave stays a reporting change.
- `bench/` is gitignored in full (`git ls-files bench/` is empty), so
  `bench/machine_turn_injection.js` — the instrument that reproduces the 293/2,658
  machine-turn split — is not versioned and cannot be re-run from a fresh clone. This is
  the repo's existing convention, deliberately kept, and applies equally to the benches the
  0.8.4 recall-precision numbers were measured with.

## [0.8.4] — 2026-09-04

Retrieval becomes asymmetric, and every relevance floor is re-derived on the index that
change produces. Measured on the real store: R@1 73.3% -> 83.3%, R@5 96.7% -> 100%,
standing-rule recall 7/13 -> 13/13, off-topic injection 1,138 -> 189 chars. The number
that matters most is none of those: on/off-topic separation 0.009 -> 0.071, which is what
makes a relevance floor a sound instrument rather than a constant fitted to its own sample.

### Changed
- **Retrieval is asymmetric now: EmbeddingGemma's prompt template is applied.** Until now
  queries and documents were embedded as raw text through one symmetric path, so the
  model's retrieval mode was never used. Queries embed as
  `task: search result | query: {text}`; documents as `title: {scene|none} | text: {text}`
  (`scripts/embed_prompt.js`, one definition for every call site). Measured offline on the
  live 90-fact corpus, this widens the gap between on-topic and off-topic top-1 cosine
  from **0.009 to 0.071** and lifts R@1 from 73.3% to 83.3%. The separation is the point:
  at 0.009 no relevance floor can divide the two populations, so Wave 1's floors were
  sound only on the sample they were fitted to.
- **Both relevance floors re-derived on the new distribution.** They move DOWN, not up —
  a prefixed corpus scores lower in absolute cosine. See
  `bench/RESULT_RECALL_PRECISION.md` for the pre-registered bars and the measured values.
- **`tmem sync --full` now migrates BOTH embedded populations** — atoms in `vectors.db`
  and the scene-fact bullets in `scene_facts_vec.json`. Re-embedding only atoms would
  leave `<recalled-facts>`, the primary per-turn surface, trickling back at 12 bullets a
  turn (~285 turns on a real store) with nothing reporting it.

### Added
- **A relevance gate on `<scene-navigation>`.** `<recalled-facts>` and `<memories>` had
  floors; the two always-on blocks had none, so the negative control was grading the two
  surfaces that were already gated and ignoring the one that was not. Measured in hook
  scope over 50 queries, scene-nav billed 948 characters on every turn — **948 of the
  1,138 an off-topic turn received, 83%**. A scene is now named only when one of its facts
  clears `NAV_FLOOR = 0.40` against the query, reusing similarities the fact ranking
  already computed (no extra embed). Off-topic injection p50 **1,138 → 189 chars**;
  on-topic 2,145 → 2,106. Without a query vector the index renders unfiltered — an index
  has no negative-control property to lose the way a quotation does.
- **Embedding generations.** `vec_meta.embed_version` stamps which template built a
  store's vectors; the fact cache carries the same stamp in an envelope. A store on an
  older generation contributes **no atoms at all** to recall until it is re-synced —
  dropping only the vector arm would leave FTS delivering those atoms unfloored, which is
  the exact 20/20 negative-control leak Wave 1 removed. Cosine between vectors from two
  generations is not an approximation of anything; it is a comparison of embeddings of two
  different strings, and every coverage check reads green while it happens.
- **`tmem doctor` reports it**: new `vectors_stale` gap (critical), fixed by
  `tmem sync --full`. View schema bumped to 6.

### Migration
Run **`tmem sync --full --all`** once after upgrading. Until then, affected stores answer
from scene facts only; nothing is lost, and no partial state is ever compared. Contributor
stores (`tmem contrib`) re-migrate via `tmem contrib sync`.

## [0.8.3] — 2026-09-04

Recall stops injecting things it cannot justify, and starts measuring itself honestly.

### Changed
- **A relevance floor on both injection surfaces.** Neither `<recalled-facts>` (L2 scene
  facts, the primary per-turn channel) nor `<memories>` (L1 atoms) had one, so a query
  sharing zero tokens with the store still received a full injection of whatever ranked
  least badly. Atom path floors at `ATOM_FLOOR = 0.6`; the scene-fact semantic floor is
  recalibrated to `0.55`. Both are marked PROVISIONAL in source with their measured
  hand-off values — they were calibrated on un-prefixed embeddings.
- **The keyword fallback got a floor too.** Without one, an embed that timed out dropped
  the turn to keyword ranking silently and lost the negative control.
- **The automatic hook reads the project store only.** `recallDirs(projectHash, source)`
  scopes `UserPromptSubmit` to the project; CLI and the visualiser keep global + project.
  A per-turn injection sourced from an unrelated project is noise the user cannot trace.
- **A latency ceiling on fact embedding.** `FACT_EMBED_TIMEOUT_MS = 800` per call and
  `FACT_EMBED_STAGE_BUDGET_MS = 1500` for the stage, enforced by a deadline-aware
  `mapBounded`. Measured against a daemon that answers the query embed and then hangs:
  10,065 ms before, 1,665 ms after, against an 8 s hook budget.

### Fixed
- **`tmem doctor` reported three metrics against the wrong denominator.** Embedding
  coverage divided by every record rather than the eligible population; low-signal counted
  the six-class union rather than what `prune` actually deletes; consolidation dueness
  summed across projects rather than per project.
- **The async recall path dropped the fact ids it injected.** `injectedFactIds` shipped as
  a field that was always `[]` on the exact path every real turn takes — measured on the
  live store, 401 of 401 rows carried the field and 100% were empty while
  `<recalled-facts>` was delivering facts. The feedback loop was grading a blank.
- **`tmem feedback` printed fact ids as blank rows**, and reported `byId.size` as an atom
  count when the map deliberately holds both populations. Split into
  `uniqueAtoms` / `uniqueFacts`; facts render as `fact · <scene>`.
- **`orphanVectors` counted vectors of ineligible records as orphans.** An orphan is a
  vector whose record is gone, not a vector whose record is `episodic`.
- **The synchronous `recall()` ignored the scope `recallDirs` enforces**, so the CLI and
  the hook disagreed about what was visible.

### Added
- `recallAsync` accepts an injectable embedder (`opts.embedFn`), so the semantic path is
  testable without a live daemon — the gap that let four of these bugs pass a green suite.

Tests 456 pass / 0 fail, verified on a normal PATH and on a PATH with no `claude` binary.
Pre-registered bars: negative control 0/20 and 1/20 (bar ≤1/20), held-out paraphrase
29/30 = 96.7% (bar ≥85%), p50 injected chars 2009 (bar ≤2000 — still over by 9; the bar
was written before the measurement and has not been moved).

## [0.8.2] — 2026-09-04

Consolidation stops asking the session to do it, and runs headless instead.

### Changed
- **Consolidation runs outside the session.** The Stop hook used to exit 2 with an
  `asyncRewake` message asking the main agent to dispatch the memory-consolidator, so
  the only step that turns raw L1 atoms into readable L2 scene facts depended on the
  session complying, and spent the session's own context. Measured over 14 days of real
  traffic (838 injected turns, 17 projects): 74% of sessions had zero scene write while
  still running, 19% of turns had no consolidation at all, median turn waited 4.15 h.
  Compliance was not the problem — 24 of 26 woken sessions did dispatch — the wake
  almost never fired. `scripts/consolidate_runner.js` now runs `claude -p
  /memory-consolidate` as a detached subprocess that outlives the session.
- **Two trigger arms, not one.** A turn counter plus the session boundary. The session
  arm is not redundant: the median session is 4 turns, so a project with short sessions
  never accumulates enough to fire at any counter threshold.
- **Success is a measured store delta, never the exit code.** The spike that validated
  this approach returned `is_error: false` and a confident "I folded it into the scene"
  while the store was byte-for-byte unchanged. Every run appends its verdict, cost and
  delta to `consolidation_runs.jsonl`; `tmem status` summarises it.
- **The `memory-consolidator` agent now has one trigger only** — dispatch after
  `/memory-seed`. There is no automatic path through it any more.

### Added
- `MEMORY_TENCENTDB_HOME` overrides the store root, which is what lets a run be pointed
  at a sandbox store. Note that a child reaching `tmem` through Claude Code's Bash tool
  resolves it through a *login* shell, so a PATH shim does not isolate it — repoint the
  resolved binary and verify with `bash -lc 'readlink -f $(command -v tmem)'`.
- Five `tmem config consolidate-*` keys: `auto-consolidate`, `consolidate-on-session-end`,
  `consolidate-model`, `consolidate-max-runs-per-day`, `consolidate-budget-usd`.

### Fixed
- **Test-suite temp-directory leak.** One `npm test` left 51 scratch directories and
  1,413 had accumulated. Fixed once via `--import ./test/_tmp_cleanup.js`, scoped to the
  process that created them — a sweep by name or timestamp would delete a parallel
  sibling's live fixture. 51 → 0.
- **A live test-isolation bug.** Two tests in `project_lock.test.js` deleted
  `MEMORY_AUTO_CONSOLIDATE` in their `finally` instead of restoring it, removing the
  suite-wide kill switch for every later test in the file; their hook subprocesses then
  spawned real `claude -p` runs. Cause of an intermittent failure and of a 364 ms test
  taking 1705 ms.
- Docs: the five `consolidate-*` config keys were undocumented, `consolidate-every`'s
  default was listed as 20 against the code's 10, and the pipeline table still credited
  dispatch to the session.

### Measured
First production run, six scopes with backlogs of 152/32/32/32/29/22 pending turns:
**6/6 `verdict: changed`**, 7-12 turns, 50-164 s, $0.41-1.11 each ($4.07 total).
Produced 5 new scene files (98 → 103), +51 scene-fact bullets (961 → 1012), 5
project-doctrine writes, 18 changelog rows. The recall-eligible L1 pool went 104 → 103
(the −1 a duplicate the child's own dedup removed) — expected, because consolidation's
write surface is L2/L3 by design and the scene-fact bullet, not the L1 atom, is the
per-turn recall surface.

## [0.8.1] — 2026-08-10

Per-project consolidation + a measured optimization of the consolidator agent.

### Changed
- **Per-project consolidation counter, trigger, and single-flight lock.** The turn
  counter and consolidation trigger were global — one busy project drove the shared
  counter to threshold while the active/target project diverged, and a single global
  lock (non-atomic write, 5-min stale reclaim) let two consolidator agents run in
  parallel on the same store. Now `capture_state.projects[<hash>]` counts and triggers
  per project; cascade state is per-project; the lock is per-project, acquired
  atomically (O_EXCL) with a 30-min mtime-TTL (`TMEM_LOCK_TTL_MS`) and race-safe stale
  reclaim. Two different projects consolidate in parallel; the same store never
  double-runs. Migration is lazy/additive (a slot is seeded to its existing backlog,
  so upgrade makes no project due at once).
- **Consolidator agent optimized for fewer calls/tokens.** Profiled on 59 real
  subagent transcripts: the tail cost was shell repo-poking (38.6x) and fragmented
  state reads (1.9x). Added `tmem consolidate-context` (one JSON bundle of status +
  scenes + atoms delta + persona + doctrine + changelog, replacing 5-6 separate
  reads) and `tmem write-scenes` (batch scene write from one JSON array); the
  memory-consolidate skill + agent now carry a hard atoms-only boundary (no
  grep/find/cat/ls/sed, no repo exploration).

## [0.8.0] — 2026-08-06

Closes six measured end-to-end gaps in the memory pipeline (capture → embed →
recall → maintain). Every change was measured on the real store.

### Added
- **Deterministic session digest (`tmem digest`).** Capture stored only the user
  prompt and dropped the tool blocks where the machine-certain facts live (files
  edited, tests, git/releases). The digest recovers them with no LLM and, when a
  turn used a tool, the Stop hook auto-captures them. Atoms are keyed by
  `(session, slot)` so re-running is idempotent (measured: re-digest writes 0),
  and stored as `type=semantic` so they survive recall's distilled-atom filter and
  are recallable per-turn.
- **`tmem feedback`.** Recall logged which atoms it injected each turn but nothing
  read it back. Tallies the log into hot (recalled) vs cold (never-recalled) atoms
  — the honest prune target. Measured: 94% of stored atoms had never been recalled.
- **`tmem persona-candidates`.** Surfaces user-facts that recur as episodic atoms
  across ≥N project stores — evidence they belong in the global persona rather than
  one repo. Surfaced only; promotion stays human-gated.
- **Cross-store consolidation back-edge.** Consolidation dueness was a global turn
  counter but the work is per-project, so a store visited briefly then left stayed
  blind (episodic atoms, no scenes) forever. The pipeline now also triggers on
  blind stores and names their (round-trip-verified) paths so the consolidator
  targets the right one.

### Fixed
- **Stop embedding recall-ineligible atom types.** `episodic`/`persona` atoms were
  embedded but recall drops them, so the vector index was 98% dead weight that
  starved every KNN — measured 0 of 10 nearest neighbours survived the filter, so
  the vector arm of `<memories>` returned nothing on every query. `isVectorEligible`
  is now the single source of truth shared by the write side (what to embed) and the
  read side (`keepDistilledAtoms`), and `tmem sync` prunes stale vectors. Measured
  after: dead vectors 4138 → 0; vector-arm survivors 0/10 → 6/6.

### Changed
- **`tmem --help` grouped by bounded context** (Capture / Consolidate / Recall /
  Maintain), with `doctor` as the front door to Maintain (reachability, capture
  signal, recall feedback, cross-store awareness). README documents the contexts.

### Performance
- The pipeline's blind-store sweep is throttled to once every `TMEM_BLIND_SCAN_EVERY`
  (10) turns instead of every Stop; the transcript digest to once every
  `TMEM_DIGEST_EVERY` (3) turns (idempotent, so nothing is lost). Added
  `PRAGMA busy_timeout=5000` so overlapping digest writers wait instead of failing;
  `doctor` opens stores read-only. (From an independent code-review pass.)

## [0.7.7] — 2026-08-06

### Fixed
- **`tmem sync` now selects records to embed by identity, not by count — fixing a
  store that never converged.** The delta path computed `missing = records −
  vectors` and embedded the newest-N records by `updated_time`, assuming the
  records lacking a vector were the most recently updated. When they were not,
  `upsertVec` overwrote the newest (already-vectored) records, the vector count
  never moved, and the store re-embedded the same wrong N on every run — wasted
  embedding compute that never closed the gap. Measured on a real store: 226
  records stuck missing, with 0 of the 226 truly-missing (older) records in the
  newest-226 set the sync kept re-embedding. Sync now embeds exactly the records
  whose `record_id` is absent from the vector store (`VectorStore.existingIds()`),
  so it converges in one pass (that store went 1740/1966 → 1966/1966).

### Fixed
- **Prewarm the embedding daemon at SessionStart, fixing cold-start recall.** On a
  cold session the embedding model loads in ~2s (measured) — longer than the
  1500ms per-turn embed timeout — so the first query of a session embedded null and
  per-turn `<recalled-facts>` recall silently fell back to keyword ranking. Measured
  on a paraphrase set: cold turn-1 surfaced 48% vs 91% once warm (a 43pp hit on the
  first, highest-context turn). The SessionStart hook now kicks `ensureDaemon()`
  fire-and-forget, so the ~2s load overlaps the user reading the session preamble
  and typing; by the real first query the daemon answers within the timeout and
  recall runs in the semantic regime. Best-effort and non-blocking (detached +
  unref'd); a spawn failure just leaves the prior cold-start behaviour.

## [0.7.5] — 2026-08-06

### Changed
- **`<recalled-facts>` ranks by embedding cosine, not keyword overlap.** The 0.7.4
  pivot made scene-body facts the primary per-turn memory but ranked them with the
  keyword TF-IDF scorer, which hard-drops any fact sharing no query token. Measured
  on a paraphrase set (real facts, questions reworded to avoid the fact's keywords —
  ML-style unseen data): keyword recall surfaced the right fact for only **48%** of
  reworded questions vs a **95%** embedding-cosine ceiling — recall was brittle to
  rephrasing. `recallAsync` now ranks facts by cosine against the query vector it
  already computes for atom search (via the embed daemon), reusing a per-turn
  bullet-vector cache keyed by content hash. Unlike the keyword path it does not
  hard-drop zero-overlap facts; a floor keeps off-topic queries empty
  (negative-control safe). Falls back to the keyword ranker when the daemon is cold.
  Re-measured, same set: paraphrase surfaced **48% → 91%** (+43pp), brittleness gap
  50pp → 9pp; held-out facts (not used to build the fix) **97%**. New pure ranker
  `scene_nav.rankSceneFactsSemantic`; sync `recall()` unchanged (keyword fallback).

## [0.7.4] — 2026-08-05

### Changed
- **Per-turn recall surfaces distilled scene-facts, not raw episodic echoes.**
  Raw auto-captured L1 atoms are un-distilled user turns, so recalling them by
  query similarity returned echoes of the current turn (measured 1/10 helpful on
  real questions). Recall now injects a `<recalled-facts>` block — scene-body
  bullets (Key Facts / Decisions) ranked against the query with the same scorer
  scenes and persona use — and drops raw `episodic` atoms from `<memories>`
  (keeps distilled `instruction`/`semantic`). No new LLM step, no new atom type;
  the distillation that already happens into scenes becomes the recall source.
  Re-measured on the same 10 real questions (independent judge): helpful 1→5,
  irrelevant 3→1. `scene_nav.rankSceneFacts` (pure) + `memory_recall`
  `readSceneFacts`/`buildFactRecall`/`keepDistilledAtoms`; both recall paths.
- **memory-consolidate skill**: scene-body bullets are now a per-turn recall
  surface, so each must be a self-contained answering fact carrying the
  outcome/number, not a topic label. Corrects the stale "body is on-demand and
  has no budget" guidance.

## [0.7.3] — 2026-08-05

### Fixed
- **npm-standalone launcher shadowing** — `tmem.js` resolved the newest plugin-cache
  `cli.js` *before* its own sibling, so `npx @baodq97/tmem` on a machine that also
  had the plugin installed ran the stale plugin code instead of the npm package's
  own `cli.js` (e.g. `tmem version` → `Unknown command`). The sibling `cli.js` is
  now authoritative; the plugin-cache scan is the fallback only for the lone PATH
  shim (which has no sibling). Hooks still resolve via `$CLAUDE_PLUGIN_ROOT` first,
  and the installed shim still self-corrects to the newest plugin.

## [0.7.2] — 2026-08-05

### Added
- **`tmem version`** (aliases `--version`, `-v`) — prints the resolved CLI version,
  the actual `cli.js` path, and the node version, so version drift is diagnosable
  in one call instead of guessed.
- **`tmem update`** — checks the npm registry for a newer `@baodq97/tmem`; prints
  the install command, or runs the global install with `--apply`. Fail-open:
  offline prints a soft note, never an error. Logic is a pure `version_check.js`
  (`cmpVersion`/`updateStatus`), unit-tested without a network call.
- **The CLI is published to npm as `@baodq97/tmem`** (CLI-only — `scripts/` +
  README + LICENSE, no plugin assets), installable via `npx @baodq97/tmem` or
  `npm i -g @baodq97/tmem`. README + the `tmem-cli` skill document it. The launcher
  already resolves a sibling `cli.js`, so a plain npm-global install runs
  standalone (verified byte-identical to the repo script for `--help`, `search`,
  `persona`). Requires Node ≥ 24.

### Fixed
- **`.claude-plugin/marketplace.json` version drift** — it still read `0.4.3`
  while the plugin had advanced to `0.7.x`; realigned to the current release.

## [0.7.0] — 2026-08-05

Measured memory-quality release. Recall stops re-injecting the persona blob every
turn; consolidation stops re-reading the whole atom pool every run.

### Added
- **Two-clock recall.** The persona is a *session* clock, injected once at
  SessionStart as the tier-0 `<persona-core>`; the *per-turn* clock carries only
  the query-relevant delta (episodic/instruction atoms + a small tier-1 persona
  slice + the scene-nav index). Persona-type atoms are dropped from the per-turn
  `<memories>`. Measured: per-turn persona redundancy 43% → 0%, atom volume
  preserved. Tests: `test/recall_two_clock.test.js`.
- **Hybrid persona by scope.** A cross-project global `<persona-core>` plus a
  per-project `<project-doctrine>` (this repo's SOPs/anti-patterns), each
  projected under its own tier-0 budget so a long doctrine can't crowd out the
  global persona. `tmem write-persona --scope global|project`. Tests:
  `test/write_persona_scope.test.js`, `test/session_start_hybrid.test.js`.
- **Persona write gates.** A tier-0 budget gate (reject a persona that would
  silently drop standing rules at session start) and a secret gate (reject
  secrets/infra values in a *global* persona; project doctrine is exempt;
  `--force` overrides). Tests: `test/persona_budget.test.js`.
- **PreToolUse guardrail.** Before a Bash command runs, the project doctrine's
  anti-patterns are matched against it and surfaced as a warn-only
  `<memory-guardrail>` (fail-open). Tests: `test/pre_tool_guardrail.test.js`,
  `test/guardrail_match.test.js`.
- **Incremental consolidation read.** `tmem atoms --since <iso> | --since-last`
  scopes the L1→L2/L3 read to the delta since the last run (cursor
  `state.projects[<hash>].last_consolidated`, advanced by `tmem mark-done`).
  Measured (pilot): consolidation read 141 → 1 for the next round. Tests:
  `test/incremental_consolidation.test.js`.
- **Warmup cadence.** A fresh store consolidates almost immediately (threshold 1)
  then doubles (1→2→4→8→…) up to `consolidate-every`, so a new project isn't
  blind while a mature one isn't over-consolidated. Accelerates the
  L1/consolidation trigger only. Tests: `test/warmup_cadence.test.js`.
- **Recall enrichments.** Each injected memory line carries a compact date
  (staleness signal); the block carries a one-line `tmem search`/`tmem scene`
  "search deeper" affordance. Tests: `test/recall_render_enrich.test.js`.
- **`tmem doctor` upgrade nudges.** After upgrading, existing stores keep the old
  shape until re-consolidation (no schema migration — all additive). `doctor`
  now nudges the stores that would benefit: persona over budget, secrets in a
  global persona, a project with atoms but no doctrine, or atoms but a
  missing/empty persona (recovery). Tests: `test/upgrade_nudges.test.js`.

### Changed
- `redact.js` cloud-id detection dropped weak keywords (`directory`/`client`/`az`)
  to cut false positives; kept `azure`/`subscription`/`tenant`/`workos`/`aad`.
- The memory visualiser (`tmem view`) now surfaces the hybrid persona's
  per-project half: the tree shows two L3 roots (global persona-core vs this-repo
  project-doctrine), about-you shows the doctrine as a second document, health
  shows an "Activate new features" nudges card (via the canonical
  `doctor.buildUpgradeNudges`), and the injection tiers carry two-clock labels
  (session-static once vs per-turn delta). Plus always-visible legends on the
  tree and about-you screens. Contract `SCHEMA_VERSION` 3 → 5.

## [0.5.2] — 2026-08-03

### Fixed
- **The recall (read) path could create schema, turning an honest "unmeasured" store into a manufactured "measured 0%".** `MemoryStore` and `VectorStore` opened *read-write* on every recall, so their constructors ran `PRAGMA journal_mode=WAL`, `CREATE TABLE`/`CREATE VIRTUAL TABLE` and the `schema_version` insert unconditionally on open — meaning a recall against a **missing** or **never-synced** store silently *created* it (empty `l1_records`/`l1_fts`/`l1_vec`), so a store that had never been measured started reporting as present-and-empty. Both constructors now take a `{ readOnly }` option (default `false`, so the writer path is byte-for-byte unchanged), and all five recall sites in `memory_recall.js` — in both `recall()` and `recallAsync()`, which must move together because `on_user_prompt.js` calls `recallAsync` and falls back to `recall` on throw — open read-only: no `mkdir`, no WAL pragma, no `CREATE`. Verified against 52 live stores (all already schema'd + WAL): a real recall returns byte-identical content and writes nothing new to the store files.
- **Behaviour change — graceful per-store degradation.** Closing the write path unmasks three failure modes schema-creation used to hide: the DB file does not exist (`SQLITE_CANTOPEN`), it exists but has no `l1_fts`/`l1_vec` table (`no such table`), or `sqlite-vec` fails to load. A new `openMemoryStoreRO()` helper opens read-only and probes once, returning `null` on any failure so **that** store degrades to "contributes nothing" while its sibling still answers — a missing PROJECT store no longer suppresses the GLOBAL store, and vice versa — and `recall()`/`recallAsync()` never throw (the result is injected into every turn). Net effect: a schemaless or missing store now contributes nothing instead of being silently created. Tests: `test/recall_read_only.test.js`.

## [0.5.1] — 2026-08-03

### Fixed
- **`/memory-init` keyed the project store to the plugin cache dir instead of the user's project.** The command's one-liner ran the launcher bootstrap and the init in the same shell — `cd ${CLAUDE_PLUGIN_ROOT} && npm install && npm link && install scripts/tmem.js …; tmem init` — so the `cd` into the plugin cache **leaked** past the `;` into `tmem init`. `tmem init` keys the store by cwd, so it created a store slugged for the cache path (e.g. `-home-bd-.claude-plugins-cache-tencentdb-agent-memory-tencentdb-agent-memory-0.5.0`) rather than the real project root the user was sitting in. Each release cut its own dead store: four had accumulated — one per version since 0.2.3 (`0.2.3`, `0.4.2`, `0.4.3`, `0.5.0`) — every one **0 records, no scenes**, because nothing ever recalls against a cache-path slug. The real project stores were never at risk: they are keyed by the SessionStart/recall paths, which run in the session cwd and resolve the project *root*, not by `/memory-init`. The fix wraps only the bootstrap in a subshell — `( cd "${CLAUDE_PLUGIN_ROOT}" && npm install … && npm link … && install … ) 2>/dev/null; tmem init` — so the `cd` dies with the subshell and `tmem init` runs in the user's original cwd. Audited the whole class for the same defect: the SessionStart self-heal (`ensureLauncherInstalled`, a v0.4.3 feature) installs the launcher via absolute paths and never `chdir`s; the `tmem` launcher spawns `cli.js` with an inherited cwd and no `chdir`; `/contrib` and the README carry no `cd`-then-cwd-command pattern — `/memory-init` was the only instance. The four empty cache-keyed stores were verified (`l1_records == 0`, no `scene_blocks/`) and removed.

## [0.5.0] — 2026-08-03

### Added
- **Tiered L3 persona delivery (`scripts/persona_projection.js`).** The persona was delivered as `truncate(persona, 400)` — on a real 39,090-char / 81-bullet / 5-section persona that is 401 chars (1.03%), every one of them from `## Identity`, byte-identical on every turn, while the sections that actually govern behaviour (`Preferences`, `Working Style`, `Standing Instructions`) got nothing. Bullets are now classified by **duty** and delivered on the channel that duty needs: `always` → **tier 0**, injected once per session by the `SessionStart` hook as `<persona-core>`; `conditional` → **tier 1**, query-matched per turn inside `<memory-context>`; `reference` → **tier 2**, never injected, read on demand via `tmem persona --section <name>`. Tier 0 also carries a one-line index of *every* section name — including sections it delivered nothing from — because a progressive-disclosure pointer the agent doesn't know the targets of is unusable (same lesson as `<scene-navigation>`). The projection is pure and synchronous (one file read, no DB, no network), so the hook hot path stays inside its timeout, and it falls back to the previous exact output whenever the tiered projection comes back empty — never emit nothing where we used to emit something. Tests: `test/persona_projection.test.js`.
- **`tmem persona --sections` / `--section <name>`.** `--sections` lists each section with its bullet count and always/conditional/reference split (the tier-2 discovery surface); `--section <name>` prints one section verbatim, with prefix matching plus explicit ambiguous/missing errors.
- **`tmem config persona-max-tokens N`** — the tier-0 budget, env-overridable via `MEMORY_PERSONA_MAX_TOKENS`. Unlike `scene-max-tokens`, `0` is **rejected** rather than treated as "disable": an empty projection is indistinguishable from "no persona learned yet" on the agent's side, which is the exact failure this store exists to fix.
- **Memory visualiser (`tmem view`, `scripts/view/`, skill `memory-view`).** A live read-only lens on the store, built to answer one question — *does the agent actually know me?* — via a Context lens (which persona bullets reach the agent, on which tier) plus a Health strip. Every database handle is opened with `DatabaseSync(..., { readOnly: true })`, so "the visualiser never writes" is enforced by SQLite rather than by discipline. The server is session-keyed and the URL is required verbatim: the page renders raw auto-captured prompts from *every* project, so `localhost` alone is not a boundary. `--snapshot [--stdout]` exports the payload JSON once for before/after measurement, `--static` pins the numbers so they cannot move under a reader mid-measurement, `--root <dir>` reads another store. Session output goes to `<root>/view/`, never inside a repo. The CLI is the only entry point — `serve.js` is an internal module and the skill shells out to `tmem view` rather than reimplementing a metric or a route. Tests: `test/view_extract.test.js`, `test/view_transform.test.js`.
- **Write-time noise gate (`scripts/low_signal.js`, `tmem config noise-gate [on|off]`).** The visualiser measured 39.2% of the store (2,187 of 5,576 records) as low-signal, and proved it a *write*-side defect: the largest single duplicate group is 96 identical copies of one `<task-notification>` envelope, and deleting the junk afterwards was worth 0.04% of delivered context. So `memory_auto_capture.autoCapture()` now refuses the noise at write time instead — but only the three classes that are unambiguously machine-generated text the user never typed: `taskNotification` (the harness's `<task-notification>` envelope, 1,424 records), `skillEcho` (`Base directory for this skill: …`, 370 records across 75 skill paths) and `empty`. `pasteDump`, `slashOrTag` and `continuation` are **deliberately left un-gated**, each verified against the real corpus: length is a proxy for "was truncated", not "is noise" (gating `pasteDump` would be the largest data loss in the store's history, decided by a character count); of the 4 `/`-prefixed records only `slashOrTag` can see, three are genuine user questions; and of 47 `continuation` records perhaps five are bare assent, the rest are directives that merely open with "ok" or "đồng ý". The gate **fails open** — if the classifier cannot load it stores the record, because losing a turn is worse than keeping a noisy one — and every refusal is logged to `changelog.jsonl` with the matched class, so a wrong rule is greppable rather than a silent drop. The classifier is the *same* predicate `tmem view` reports with, pinned by a test, so the dashboard and the writer can never name different junk. Env-overridable via `MEMORY_NOISE_GATE`; on by default. Tests: `test/low_signal.test.js`.
- **Append-only recall log (`recall_log.jsonl` at the memory root).** Every recall now records one JSONL row — `source` (`hook` vs `cli`), the verbatim query, the `injectedIds` and `droppedIds`, and the injected `chars` — so the ranking can be evaluated offline against the exact prompts that produced it. The empty recall (nothing injected) is logged too; it is the most interesting row in the file. No SQLite involved by design — recording a read in the DB would put the read path behind a write lock. Rotation is a single-generation rename at 2 MB (`.jsonl.1`, steady-state ceiling 4 MB), sized from the measured ~35–50 KB/day of a real store; a `.1/.2/.3` cascade would rename N files per turn on the hot path to buy history nobody asked for. The whole path **fails open** — a read-only filesystem, a full disk or a missing root all degrade to "no log", never "no memory".

### Changed
- **Scene-navigation rendering extracted to one shared pure module (`scripts/scene_nav.js`).** `renderSceneNav(orderedScenes, maxChars)` — plus `NAV`, `heatEmoji`, `truncate`, `navLine`, `CHARS_PER_TOKEN` — now serves both callers. `memory_recall.buildSceneNav()` keeps what is genuinely its own: the filesystem reads, and the project-before-global ordering that decides who drops first under budget (a recall *policy*, not a rendering rule). The reason it had to move is the interesting part: `transform.js` carried a hand copy of the whole algorithm and five literals, because the pure view layer cannot import `memory_recall` — that would drag `MemoryStore`/`VectorStore` and `node:sqlite` into a module whose contract is that it does no I/O, which a test asserts. The copy was **already drifting**: `memory_recall`'s atom loops changed `break` → `continue` on this branch while the copied scene loop kept breaking. One renderer now means the deferred scene-nav fix is one edit in one place instead of two that can silently disagree. Behaviour-preserving, verified byte-identical against the previous implementation across 51 stores × 6 budgets (306 combinations, 0 mismatches, identical digests) — the scene loop's `break` semantics are reproduced verbatim, not improved.
- **`persona-max-tokens` default raised 300 → 1200.** This is affordable **only because tier 0 is paid once per session, not once per turn** — the per-turn channel is tier 1, whose budget (420 chars, ~105 tokens) was deliberately *not* widened. Anyone reading 1200 as a per-turn cost will "optimise" it back and silently restore the truncation this release exists to remove. At 300 tokens the projection reached 5 of 47 `always`-duty bullets, 4 of them cut mid-rule.
- **Tier 0 no longer truncates: a bullet is delivered whole or skipped.** `DEFAULT_BULLET_MAX_CHARS` (600) changed meaning for tier 0 from a truncation cap to an **eligibility threshold**, and the keep-ratio guard (`MIN_KEPT_RATIO`, `SHORT_SOURCE_CHARS`) is deleted. That guard was a proxy for "the operative clause survived", and it failed at its own job: a 1,145-char Standing Instructions bullet was delivered at 594 chars — 51.9%, comfortably over the 0.5 threshold — with its `Amended for orchard-flow only` carve-out cut away, so the agent received a **stricter rule than the user wrote**. Clause position does not correlate with bullet length, so no ratio can catch that. Measured after the change: **13 bullets delivered (was 12), 0 truncated (was 4)**, 4,673 of 4,800 chars, hook output 4,990 chars with zero ellipses. The cost is honest and stated: **11 of 47 `always` bullets exceed 600 chars and are now undeliverable** (that Standing Instructions bullet among them) — absent rather than misleading. `skills/memory-consolidate/SKILL.md` now instructs the writer accordingly: one rule per bullet, operative clause first. **Tier 1 still truncates**, deliberately — tier 1 is cover, tier 0 is contract.
- **The persona block no longer charges the L1 atom budget.** Recall billed the persona's ~425 chars against the same pool as the atoms, so up to 425 of a 1,120-char pool was spent before a single memory was considered. Tier 1 now has its own budget, the same convention `<scene-navigation>` already used.
- **Scene navigation is now ranked by the current query, not byte-identical every turn.** The extraction above preserved the previous order faithfully — which was the problem: `<scene-navigation>` rendered the same heat-sorted list on every prompt regardless of what the user asked, so the five scenes a budget can fit were fixed for the session while the relevant ones sat below the cut. `rankScenes()` now scores each scene against the query (the same IDF relevance math the persona projection uses, in the shared `scene_nav.js`), and **heat is a tiebreak only**. Query-ranking changes *which* five scenes appear, not *how many* — the count is bounded by nav line width, which is a write-side ceiling recorded as a known gap below.
- **The scene heat flame ladder was realigned to the scale that is actually written.** `heatEmoji()` used to emit flames only at heat ≥ 50 climbing to 1,000, while `skills/memory-consolidate/SKILL.md` tells the writer heat is 1–5 — so across 219 real scenes not one flame ever rendered and the cue was dead code (the visualiser reports this as `heat_scale_mismatch`). The ladder now matches: heat 5 gets two flames, heat 4 gets one, 1–3 get none. Two rungs, not five, because the live distribution is degenerate (130 of 219 scenes at heat 5) so a rung per value would spend per-turn chars on a cue that does not discriminate. `contract.js:HEAT_SCALE.READER_FIRST_FLAME_AT` states the first rung independently and a load-time assertion fails if the two disagree. (This closes the "heat ladder has never rendered" known gap from the mid-branch draft.)
- **Tier-1 conditional persona bullets are scoped to the project they name.** `persona.md` is one global document while L1/L2 are per-project, so a `conditional` bullet written for one repo arrived as a standing rule in every other repo — measured: the prompt "run the eval suite and report numbers" selected a rule about `tools/kg.py`, a file that exists only in a different repo, while working here. That is a *correctness* defect, not a budget one: a rule from the wrong project is a wrong rule, indistinguishable from inside the block. Scope is read from what authors already write — a parenthetical project tag on the bullet's *label* (`**X** (orchard-ops): …`) or a repo-relative artifact path in the body — with no new file format. A tagged bullet is dropped **only** on a positive mismatch (a named project that is not this one, or an artifact path with no trace of it here); untagged bullets stay universal, and every "cannot tell" (no hints, no scope context, no resolvable root) resolves to KEEP, because dropping a genuine standing rule is far worse than occasionally admitting a foreign one. The decision stays pure — `scope.hasPath` is injected by the caller — so the visualiser replays it offline. **Tier 0 is deliberately not scoped**: measured across 6 projects, filtering there freed 0 chars for 0 gain.
- **Authoring ceilings added to `skills/memory-consolidate/SKILL.md`.** A **160-char** hard ceiling on tier-0 `always` persona bullets (derived from 4,800 tier-0 chars ÷ ~30 standing rules; today's average bullet is 478 chars, i.e. three rules' worth of slot), and an **80-char** ceiling on scene summaries (the nav renderer truncates there, so anything past char 80 is displayed nowhere). Both rules apply to bullets/summaries merely carried through re-consolidation, not just new ones — that is the only path by which an already-bloated store improves. This is the write-side complement to "tier 0 no longer truncates": since the reader can now only drop or deliver whole, the writer has to keep bullets deliverable.
- **Snapshot exports pruned to the newest 10; store schema bumped to v3.** `tmem view --snapshot` now keeps only the 10 newest exports per session dir (an unpruned real store had accumulated 14), deleting only files matching its own `s<n>-…` affix pair and never events.jsonl / server-info.json / lockfiles. `SCHEMA_VERSION` is now **3**, embedded in every snapshot id (prefix `s3-`) and API envelope so a snapshot persisted under an older shape is rejected rather than misread.
- **Shared constants extracted to a leaf module (`scripts/constants.js`); `/simplify` cleanup.** Values that cross module boundaries — the low-signal taxonomy, `CHARS_PER_TOKEN`, the tier-0 budget — lived inside whichever module used them first, forcing importers to pull in far more than a value (the Stop hook was loading 1,300 lines of `view/contract.js` per turn to read two objects, and `CHARS_PER_TOKEN = 4` was hand-copied in three files). They now live in a require-nothing leaf that is free to import from anywhere, including the modules whose tests assert they do no I/O. Internal refactor: no behaviour change, contract pinned by a value-digest test.

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
- **The scene-navigation block fits only ~5 scenes per turn.** Query-ranking (above) changed *which* scenes appear but not *how many*: the nav line is ~130 chars against an 800-char budget, so of 219 real scenes about 214 are unreachable in any given turn. This is a write-side ceiling — summaries average 164 chars — and the 80-char summary rule now nudges it down, but the structural fix (fewer, denser scenes) is a consolidator concern deferred past this release.

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

[0.5.0]: https://github.com/baodq97/tencentdb-agent-memory/releases/tag/v0.5.0
[0.2.3]: https://github.com/baodq97/tencentdb-agent-memory/releases/tag/v0.2.3
[0.2.2]: https://github.com/baodq97/tencentdb-agent-memory/releases/tag/v0.2.2
[0.2.1]: https://github.com/baodq97/tencentdb-agent-memory/releases/tag/v0.2.1
[0.2.0]: https://github.com/baodq97/tencentdb-agent-memory/releases/tag/v0.2.0
[0.1.0]: https://github.com/baodq97/tencentdb-agent-memory/releases/tag/v0.1.0
