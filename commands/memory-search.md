---
description: Search L1 structured memories via the Gateway (BM25 + vector hybrid).
argument-hint: <query>
allowed-tools: [Bash]
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/gateway_client.js search-memories "$ARGUMENTS"
```
