---
description: Show Gateway /health, supervised PID, and the memory data directory tree.
allowed-tools: Bash
---

```bash
python ${CLAUDE_PLUGIN_ROOT}/scripts/gateway_supervisor.py status
```

Then show the top of the data directory:

```bash
DATA_DIR="${TDAI_DATA_DIR:-$HOME/.memory-tencentdb/memory-tdai}"
[ -d "$DATA_DIR" ] && (cd "$DATA_DIR" && find . -maxdepth 2 -type d | head -30 && echo && ls -1 *.md *.db 2>/dev/null) || echo "data dir not present yet: $DATA_DIR"
```
