---
description: Search raw L0 conversation history via the Gateway.
argument-hint: <query>
allowed-tools: [Bash]
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/gateway_client.js search-conversations "$ARGUMENTS"
```
