---
description: List L2 scene blocks (Markdown) in the memory data dir.
allowed-tools: [Bash]
---

```bash
DATA_DIR="${TDAI_DATA_DIR:-$HOME/.memory-tencentdb/memory-tdai}"
SCENES="$DATA_DIR/scene_blocks"
if [ -d "$SCENES" ]; then
  echo "# scene blocks under $SCENES"
  ls -1 "$SCENES" | head -50
  echo
  echo "view a specific scene with: cat \"$SCENES/<name>.md\""
else
  echo "no scene blocks yet — L2 fires after pipeline.l2DelayAfterL1Seconds following an L1 pass."
  echo "expected at: $SCENES"
fi
```
