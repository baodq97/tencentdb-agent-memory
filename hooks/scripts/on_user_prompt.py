"""UserPromptSubmit hook — POST /recall, inject <memory-context> via additionalContext.

On any failure (Gateway down, circuit-breaker open, timeout, malformed
response) the hook exits 0 with empty output so the user's turn is never
blocked.
"""

from __future__ import annotations

import sys

from _common import add_plugin_scripts_to_path, emit, read_hook_input, session_key

add_plugin_scripts_to_path()

from gateway_client import GatewayClient, breaker_open  # noqa: E402


def main() -> int:
    payload = read_hook_input()
    prompt = payload.get("prompt") or payload.get("user_prompt") or ""
    if not prompt.strip():
        emit({})
        return 0
    if breaker_open():
        emit({})
        return 0

    sk = session_key(payload)
    try:
        client = GatewayClient(timeout=5)
        resp = client.recall(query=prompt, session_key=sk)
    except Exception:
        emit({})
        return 0

    # Upstream Gateway /recall returns { context: "<memory-context>...", ... }
    ctx = (resp or {}).get("context") or (resp or {}).get("prependContext")
    if not ctx or not str(ctx).strip():
        emit({})
        return 0

    emit({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": ctx}})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Last-resort guard: never break the conversation.
        emit({})
        sys.exit(0)
