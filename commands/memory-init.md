---
description: Initialize local memory store + vector index for this project.
allowed-tools: Bash
---

```bash
cd ${CLAUDE_PLUGIN_ROOT} && npm install --no-fund --no-audit 2>/dev/null && npm link --no-fund 2>/dev/null && tmem init
```
