"""Shared helpers for the three hook entrypoints.

Keeps each hook script tiny — they only orchestrate; HTTP + circuit breaker
live in scripts/gateway_client.py.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def add_plugin_scripts_to_path() -> None:
    """Make gateway_client importable from hook scripts."""
    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if not plugin_root:
        # Hook scripts live at <plugin>/hooks/scripts/, so .. ../scripts
        plugin_root = str(Path(__file__).resolve().parents[2])
    sys.path.insert(0, str(Path(plugin_root) / "scripts"))


def read_hook_input() -> dict:
    """Parse the JSON payload Claude Code writes to stdin for hook events.

    Hooks receive a JSON object on stdin. We silently return {} if stdin is
    empty or unparseable so hooks never error out the conversation.
    """
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return {}
        return json.loads(raw)
    except Exception:
        return {}


def session_key(hook_payload: dict) -> str:
    """Derive a stable session key for the Gateway from the hook payload.

    Claude Code includes `session_id` on every hook payload. We namespace it
    so multiple Claude Code instances don't collide with each other or with
    upstream OpenClaw/Hermes sessions.
    """
    sid = hook_payload.get("session_id") or os.environ.get("CLAUDE_SESSION_ID") or "default"
    return f"claude-code:{sid}"


def emit(out: dict) -> None:
    """Hook scripts communicate with Claude Code via stdout JSON."""
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()
