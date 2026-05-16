"""Stop hook — POST /capture for the most recent user+assistant turn.

Reads the transcript path from the hook payload, scans the tail of the JSONL
to find the latest user message and the latest assistant message, and
fire-and-forgets `/capture` with a short timeout. Failures are swallowed so
the conversation never errors out on memory issues.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from _common import add_plugin_scripts_to_path, emit, read_hook_input, session_key

add_plugin_scripts_to_path()

from gateway_client import GatewayClient, breaker_open  # noqa: E402


def _extract_text(message: dict) -> str:
    """Pull plain text out of a Claude transcript message.

    Claude Code transcripts store assistant turns as a list of content blocks
    (`type: text`, `type: tool_use`, ...). We concatenate the text blocks and
    drop the rest.
    """
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "\n".join(parts).strip()
    return ""


def _last_turn(transcript_path: str) -> tuple[str, str]:
    """Return (last_user_text, last_assistant_text) from the transcript tail."""
    user_text = ""
    assistant_text = ""
    try:
        path = Path(transcript_path)
        if not path.is_file():
            return "", ""
        # Read in reverse for efficiency on long transcripts.
        for line in reversed(path.read_text("utf-8").splitlines()):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except Exception:
                continue
            msg = entry.get("message") if isinstance(entry.get("message"), dict) else entry
            role = msg.get("role")
            if role == "assistant" and not assistant_text:
                assistant_text = _extract_text(msg)
            elif role == "user" and not user_text:
                user_text = _extract_text(msg)
            if user_text and assistant_text:
                break
    except Exception:
        pass
    return user_text, assistant_text


def main() -> int:
    payload = read_hook_input()
    if breaker_open():
        emit({})
        return 0

    transcript = payload.get("transcript_path") or ""
    user_text, assistant_text = _last_turn(transcript)
    if not user_text or not assistant_text:
        emit({})
        return 0

    sk = session_key(payload)
    try:
        client = GatewayClient(timeout=3)
        client.capture(
            user_content=user_text,
            assistant_content=assistant_text,
            session_key=sk,
            session_id=payload.get("session_id") or "",
        )
    except Exception:
        # Gateway is fire-and-forget on its side; a hook-side failure is fine.
        pass

    emit({})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        emit({})
        sys.exit(0)
