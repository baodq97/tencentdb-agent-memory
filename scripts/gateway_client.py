"""Thin HTTP client for the memory-tencentdb Gateway sidecar.

Mirrors hermes-plugin/memory/memory_tencentdb/client.py from the upstream repo
so endpoint shapes stay in lockstep. Includes a process-local circuit breaker
to keep hook overhead bounded when the Gateway is unhealthy.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

DEFAULT_HOST = os.environ.get("MEMORY_TENCENTDB_GATEWAY_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("MEMORY_TENCENTDB_GATEWAY_PORT", "8420"))
DEFAULT_BASE_URL = f"http://{DEFAULT_HOST}:{DEFAULT_PORT}"
DEFAULT_TIMEOUT = 5

# Circuit-breaker state lives in a small file so concurrent hook invocations
# share it (each hook is a fresh Python process).
BREAKER_PATH = Path.home() / ".memory-tencentdb" / "breaker.json"
BREAKER_THRESHOLD = 5
BREAKER_COOLDOWN_SEC = 60


def _load_breaker() -> dict:
    try:
        return json.loads(BREAKER_PATH.read_text("utf-8"))
    except Exception:
        return {"failures": 0, "open_until": 0.0}


def _save_breaker(state: dict) -> None:
    try:
        BREAKER_PATH.parent.mkdir(parents=True, exist_ok=True)
        BREAKER_PATH.write_text(json.dumps(state), "utf-8")
    except Exception:
        pass


def breaker_open() -> bool:
    return _load_breaker().get("open_until", 0.0) > time.time()


def _record_success() -> None:
    _save_breaker({"failures": 0, "open_until": 0.0})


def _record_failure() -> None:
    s = _load_breaker()
    s["failures"] = int(s.get("failures", 0)) + 1
    if s["failures"] >= BREAKER_THRESHOLD:
        s["open_until"] = time.time() + BREAKER_COOLDOWN_SEC
    _save_breaker(s)


class GatewayClient:
    def __init__(self, base_url: str = DEFAULT_BASE_URL, timeout: int = DEFAULT_TIMEOUT) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _post(self, path: str, body: dict, timeout: Optional[int] = None) -> dict:
        if breaker_open():
            raise RuntimeError("gateway circuit breaker open")
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                out = json.loads(resp.read().decode("utf-8"))
                _record_success()
                return out
        except Exception:
            _record_failure()
            raise

    def _get(self, path: str, timeout: Optional[int] = None) -> dict:
        if breaker_open():
            raise RuntimeError("gateway circuit breaker open")
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                out = json.loads(resp.read().decode("utf-8"))
                _record_success()
                return out
        except Exception:
            _record_failure()
            raise

    def health(self, timeout: int = 3) -> dict:
        return self._get("/health", timeout=timeout)

    def recall(self, query: str, session_key: str, user_id: str = "") -> dict:
        body: dict[str, Any] = {"query": query, "session_key": session_key}
        if user_id:
            body["user_id"] = user_id
        return self._post("/recall", body)

    def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        session_id: str = "",
        user_id: str = "",
    ) -> dict:
        body: dict[str, Any] = {
            "user_content": user_content,
            "assistant_content": assistant_content,
            "session_key": session_key,
        }
        if session_id:
            body["session_id"] = session_id
        if user_id:
            body["user_id"] = user_id
        return self._post("/capture", body)

    def search_memories(self, query: str, limit: int = 5, type_filter: str = "") -> dict:
        body: dict[str, Any] = {"query": query, "limit": limit}
        if type_filter:
            body["type"] = type_filter
        return self._post("/search/memories", body)

    def search_conversations(self, query: str, limit: int = 5, session_key: str = "") -> dict:
        body: dict[str, Any] = {"query": query, "limit": limit}
        if session_key:
            body["session_key"] = session_key
        return self._post("/search/conversations", body)

    def end_session(self, session_key: str, user_id: str = "") -> dict:
        body: dict[str, Any] = {"session_key": session_key}
        if user_id:
            body["user_id"] = user_id
        return self._post("/session/end", body)
