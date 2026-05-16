"""SessionEnd hook — POST /session/end to flush pending L1/L2/L3 work."""

from __future__ import annotations

import sys

from _common import add_plugin_scripts_to_path, emit, read_hook_input, session_key

add_plugin_scripts_to_path()

from gateway_client import GatewayClient, breaker_open  # noqa: E402


def main() -> int:
    payload = read_hook_input()
    if breaker_open():
        emit({})
        return 0
    sk = session_key(payload)
    try:
        GatewayClient(timeout=5).end_session(session_key=sk)
    except Exception:
        pass
    emit({})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        emit({})
        sys.exit(0)
