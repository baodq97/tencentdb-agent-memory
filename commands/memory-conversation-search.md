---
description: Search raw L0 conversation history via the Gateway.
argument-hint: <query>
allowed-tools: Bash
---

```bash
python - <<'PY'
import json, sys
sys.path.insert(0, "${CLAUDE_PLUGIN_ROOT}/scripts")
from gateway_client import GatewayClient
q = """$ARGUMENTS""".strip()
if not q:
    print("usage: /memory-conversation-search <query>")
    sys.exit(2)
print(json.dumps(GatewayClient(timeout=10).search_conversations(query=q, limit=10), indent=2, ensure_ascii=False))
PY
```
