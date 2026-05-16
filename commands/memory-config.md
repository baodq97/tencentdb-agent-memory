---
description: Show or scaffold the Gateway config (tdai-gateway.json).
allowed-tools: Bash
---

```bash
CONFIG_DIR="${HOME}/.memory-tencentdb"
CONFIG="$CONFIG_DIR/tdai-gateway.json"
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG" ]; then
  cat > "$CONFIG" <<'JSON'
{
  "storeBackend": "sqlite",
  "recall":     { "enabled": true, "maxResults": 5, "scoreThreshold": 0.3, "strategy": "hybrid" },
  "pipeline":   { "everyNConversations": 5, "enableWarmup": true },
  "extraction": { "enabled": true, "enableDedup": true, "maxMemoriesPerSession": 20 },
  "persona":    { "triggerEveryN": 50, "maxScenes": 15 },
  "embedding":  { "enabled": false, "provider": "none" },
  "offload":    { "enabled": false }
}
JSON
  echo "[memory-config] created default $CONFIG"
fi
echo "# $CONFIG"
cat "$CONFIG"
echo
echo "edit it with your normal editor; full schema in upstream openclaw.plugin.json."
```
