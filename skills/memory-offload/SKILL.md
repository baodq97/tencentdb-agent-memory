---
name: memory-offload
description: Configure and tune the optional Context Offload subsystem of tencentdb-agent-memory — the Mermaid-canvas short-term compression that offloads verbose tool logs into refs/*.md so only a tiny diagram stays in context. Use when the user says "tool logs are eating my context", "compress search/code/error output", "enable Mermaid canvas", "offload tool calls", "set up context engine", or mentions offload.* config keys (enabled, mildOffloadRatio, aggressiveCompressRatio, mmdMaxTokenRatio, l2NullThreshold).
---

# Context Offload (Mermaid canvas)

Off by default; complementary to long-term memory. Layered long-term memory survives **across** sessions; context offload compresses **within** a session by replacing verbose tool logs with a Mermaid graph.

## What gets offloaded

Anything tool-like and bulky: file reads, code outputs, search results, stack traces, browser dumps. These are written to:

```
~/.memory-tencentdb/context-offload/<session>/
├── refs/                # full text of each offloaded call, named by node_id
├── offload.jsonl        # per-call summaries with node_id
└── canvas.mmd           # the Mermaid graph injected into context
```

In context the agent sees only `canvas.mmd` (tiny). When it needs detail, it greps the `node_id` and reads the matching `refs/<id>.md`.

## Enable

```json
{
  "offload": {
    "enabled": true,
    "model": "openai/gpt-4o",
    "temperature": 0.2,
    "defaultContextWindow": 200000,
    "mildOffloadRatio": 0.5,
    "aggressiveCompressRatio": 0.85,
    "mmdMaxTokenRatio": 0.2,
    "forceTriggerThreshold": 4,
    "maxPairsPerBatch": 20,
    "l2NullThreshold": 4,
    "l2TimeoutSeconds": 300
  }
}
```

Restart the Gateway (`/memory-stop` then `/memory-init`) to pick up `offload.enabled` changes.

## Trigger ladder

The Gateway watches the token budget and runs the appropriate pass:

1. **`forceTriggerThreshold` tool pairs accumulated** → L1 offload (extract relations, write refs)
2. **Context fills past `mildOffloadRatio`** (default 50%) → mild compression
3. **Context fills past `aggressiveCompressRatio`** (default 85%) → aggressive compression
4. **`l2NullThreshold` null node_ids in `offload.jsonl`** OR **`l2TimeoutSeconds` since last L2** → L2 consolidation pass

`mmdMaxTokenRatio` (default 0.2) caps the Mermaid canvas itself at 20% of the context window — it can't itself become a token hog.

## Tuning cheat sheet

| Symptom | Knob to turn |
|---------|--------------|
| Compression fires too late, context already 95% full | Drop `mildOffloadRatio` to 0.4 |
| Mermaid canvas looks empty / agent loses thread | Raise `mmdMaxTokenRatio` to 0.25, raise `forceTriggerThreshold` |
| Mermaid canvas is huge | Lower `mmdMaxTokenRatio` to 0.15; lower `maxPairsPerBatch` |
| L2 never fires | Lower `l2NullThreshold` to 2; lower `l2TimeoutSeconds` to 180 |
| Offload model is slow / costly | Set `model` to a cheaper provider/model; raise `temperature` only if you want more reorg in L2 summaries |

## Offload to a backend

If you have a centralised summariser/coder, point L1/L1.5/L2/L4 at it:

```json
"offload": {
  "enabled": true,
  "backendUrl": "https://offload-api.internal/v1",
  "backendApiKey": "${OFFLOAD_API_KEY}",
  "backendTimeoutMs": 10000
}
```

Local Mermaid injection still happens on the host; only the LLM-heavy passes are routed to the backend.

## Verify

After a long turn with several tool calls:

```bash
SESSION=$(ls -t ~/.memory-tencentdb/context-offload/ | head -1)
ls ~/.memory-tencentdb/context-offload/$SESSION/refs/ | wc -l   # > 0 means offload fired
head -50 ~/.memory-tencentdb/context-offload/$SESSION/canvas.mmd
```

If `refs/` is empty after lots of activity, raise the Gateway log level and look for `[offload]` lines — usually the model or backend call is failing.

## Caveat for Claude Code

Upstream ships a small patch (`scripts/openclaw-after-tool-call-messages.patch.sh`) for OpenClaw because OpenClaw's tool-result wire format needed an interception point. Claude Code's hooks (`PostToolUse`) give us that interception point natively — no patch needed. If you later want PostToolUse-driven offload streaming, that's a v0.2 enhancement; the v0.1 plugin runs offload entirely Gateway-side off the captured turn.
