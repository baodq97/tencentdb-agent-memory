---
description: Initialize local memory store + vector index for this project.
allowed-tools: Bash
---

```bash
( cd "${CLAUDE_PLUGIN_ROOT}" && npm install --no-fund --no-audit && npm link --no-fund && mkdir -p ~/.local/bin && install -m 0755 scripts/tmem.js ~/.local/bin/tmem ) 2>/dev/null; tmem init
```

The `tmem` command is a version-independent launcher (`scripts/tmem.js`): it resolves the cli at runtime — preferring the plugin Claude Code loaded (`$CLAUDE_PLUGIN_ROOT`), else the newest installed version — so it never drifts behind after a plugin update. Installing it to `~/.local/bin` overrides any stale hardcoded shim.
