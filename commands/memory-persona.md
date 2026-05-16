---
description: Show the current L3 persona (persona.md).
allowed-tools: Bash
---

```bash
DATA_DIR="${TDAI_DATA_DIR:-$HOME/.memory-tencentdb/memory-tdai}"
PERSONA="$DATA_DIR/persona.md"
if [ -f "$PERSONA" ]; then
  echo "# persona.md ($PERSONA)"
  echo
  cat "$PERSONA"
else
  echo "no persona generated yet — persona.md is created after persona.triggerEveryN new L1 memories (default 50)."
  echo "expected at: $PERSONA"
fi
```
