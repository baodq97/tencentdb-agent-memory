#!/usr/bin/env bash
# Clone the upstream TencentDB-Agent-Memory repo and install its deps.
# Idempotent: if the repo already exists, it just runs `git pull` + `npm install`.

set -euo pipefail

UPSTREAM_URL="${MEMORY_TENCENTDB_UPSTREAM_URL:-https://github.com/Tencent/TencentDB-Agent-Memory.git}"
TARGET_DIR="${HOME}/.memory-tencentdb/tdai-memory-openclaw-plugin"

mkdir -p "$(dirname "$TARGET_DIR")"

if [[ -d "$TARGET_DIR/.git" ]]; then
  echo "[install] upstream checkout exists at $TARGET_DIR — pulling..."
  git -C "$TARGET_DIR" pull --ff-only || echo "[install] git pull failed (continuing)"
else
  echo "[install] cloning $UPSTREAM_URL -> $TARGET_DIR"
  git clone --depth 1 "$UPSTREAM_URL" "$TARGET_DIR"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[install] ERROR: node not on PATH (need >= 22.16)" >&2
  exit 2
fi

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if (( NODE_MAJOR < 22 )); then
  echo "[install] ERROR: node $NODE_MAJOR detected, need >= 22.16" >&2
  exit 2
fi

cd "$TARGET_DIR"
echo "[install] running npm install (this can take a minute)..."
npm install --no-audit --no-fund

echo "[install] done. Upstream installed at: $TARGET_DIR"
