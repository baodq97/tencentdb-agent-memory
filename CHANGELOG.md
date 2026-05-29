# Changelog

All notable changes to this plugin are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); this project adheres to [Semantic Versioning](https://semver.org/).

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
