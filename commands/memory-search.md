---
description: Search L1 structured memories via the Gateway (BM25 + vector hybrid).
argument-hint: <query>
allowed-tools: Bash
---

```bash
node -e "
const { GatewayClient } = require('${CLAUDE_PLUGIN_ROOT}/scripts/gateway_client.js');
const q = \`$ARGUMENTS\`.trim();
if (!q) { console.log('usage: /memory-search <query>'); process.exit(2); }
new GatewayClient(undefined, 10000).searchMemories(q, 10).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => console.error(e.message));
"
```
