---
description: Clone upstream TencentDB-Agent-Memory, npm install, start the Gateway sidecar.
allowed-tools: Bash
---

Run the upstream installer and start the Gateway, then check `/health`.

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/install_upstream.sh && \
  node ${CLAUDE_PLUGIN_ROOT}/scripts/gateway_supervisor.js start && \
  node ${CLAUDE_PLUGIN_ROOT}/scripts/gateway_supervisor.js status
```

If install fails because `node` is missing or older than 22.16, install Node.js first (https://nodejs.org/) and re-run.

For LLM-backed L1/L2/L3 extraction set these env vars **before** starting:

```bash
export MEMORY_TENCENTDB_LLM_API_KEY="sk-..."
export MEMORY_TENCENTDB_LLM_BASE_URL="https://api.openai.com/v1"   # optional
export MEMORY_TENCENTDB_LLM_MODEL="gpt-4o"                          # optional
```
