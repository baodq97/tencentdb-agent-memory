"""Discover, start, and stop the memory-tencentdb Gateway Node.js sidecar.

Search order for `src/gateway/server.ts` mirrors the upstream Hermes
supervisor exactly so an existing upstream checkout is reused as-is:

  1. MEMORY_TENCENTDB_GATEWAY_CMD env var (full command override)
  2. ~/.memory-tencentdb/tdai-memory-openclaw-plugin/src/gateway/server.ts  (preferred)
  3. ~/tdai-memory-openclaw-plugin/src/gateway/server.ts                   (legacy)
  4. ~/.hermes/plugins/tdai-memory-openclaw-plugin/src/gateway/server.ts   (hermes-style)

Usage:
    python gateway_supervisor.py start    # spawn + wait for /health
    python gateway_supervisor.py stop     # SIGTERM the supervised PID
    python gateway_supervisor.py status   # print health + pid
"""

from __future__ import annotations

import json
import os
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path

from gateway_client import GatewayClient, DEFAULT_HOST, DEFAULT_PORT

STATE_DIR = Path.home() / ".memory-tencentdb"
PID_FILE = STATE_DIR / "gateway.pid"
LOG_DIR = STATE_DIR / "logs"
STDOUT_LOG = LOG_DIR / "gateway.stdout.log"
STDERR_LOG = LOG_DIR / "gateway.stderr.log"

HEALTH_INTERVAL = 0.5
HEALTH_MAX_WAIT = 30


def discover_server_ts() -> str | None:
    home = Path.home()
    candidates = [
        home / ".memory-tencentdb" / "tdai-memory-openclaw-plugin" / "src" / "gateway" / "server.ts",
        home / "tdai-memory-openclaw-plugin" / "src" / "gateway" / "server.ts",
        home / ".hermes" / "plugins" / "tdai-memory-openclaw-plugin" / "src" / "gateway" / "server.ts",
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    return None


def resolve_command() -> str | None:
    env_cmd = os.environ.get("MEMORY_TENCENTDB_GATEWAY_CMD", "").strip()
    if env_cmd:
        return env_cmd
    server_ts = discover_server_ts()
    if server_ts:
        return f"node --import tsx {shlex.quote(server_ts)}"
    return None


def read_pid() -> int | None:
    try:
        return int(PID_FILE.read_text("utf-8").strip())
    except Exception:
        return None


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def start() -> int:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    client = GatewayClient()
    try:
        h = client.health(timeout=2)
        print(f"gateway already healthy: {h}")
        return 0
    except Exception:
        pass

    cmd = resolve_command()
    if not cmd:
        print(
            "ERROR: cannot locate Gateway. Either set MEMORY_TENCENTDB_GATEWAY_CMD or run "
            "`/memory-init` to clone the upstream repo.",
            file=sys.stderr,
        )
        return 2

    stdout_f = STDOUT_LOG.open("ab", buffering=0)
    stderr_f = STDERR_LOG.open("ab", buffering=0)

    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0
        )

    proc = subprocess.Popen(
        shlex.split(cmd, posix=os.name != "nt"),
        stdout=stdout_f,
        stderr=stderr_f,
        stdin=subprocess.DEVNULL,
        env={**os.environ},
        creationflags=creationflags if os.name == "nt" else 0,
        close_fds=True,
    )
    PID_FILE.write_text(str(proc.pid), "utf-8")
    print(f"spawned gateway pid={proc.pid}, waiting for /health...")

    deadline = time.time() + HEALTH_MAX_WAIT
    while time.time() < deadline:
        if proc.poll() is not None:
            print("ERROR: gateway exited during startup. Tail of stderr:", file=sys.stderr)
            try:
                tail = STDERR_LOG.read_bytes()[-2048:].decode("utf-8", "replace")
                print(tail, file=sys.stderr)
            except Exception:
                pass
            return 3
        try:
            h = client.health(timeout=2)
            status = h.get("status")
            if status in ("ok", "degraded"):
                print(f"gateway ready: {h}")
                return 0
        except Exception:
            pass
        time.sleep(HEALTH_INTERVAL)

    print("ERROR: gateway failed to become healthy within timeout", file=sys.stderr)
    return 4


def stop() -> int:
    pid = read_pid()
    if not pid:
        print("no pid file; nothing to stop")
        return 0
    if not pid_alive(pid):
        print(f"pid {pid} already exited")
        PID_FILE.unlink(missing_ok=True)
        return 0
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], check=False)
        else:
            os.kill(pid, signal.SIGTERM)
        print(f"sent stop signal to pid {pid}")
    except Exception as e:
        print(f"failed to signal pid {pid}: {e}", file=sys.stderr)
        return 1
    PID_FILE.unlink(missing_ok=True)
    return 0


def status() -> int:
    pid = read_pid()
    client = GatewayClient()
    health = None
    try:
        health = client.health(timeout=2)
    except Exception as e:
        health = {"status": "down", "error": str(e)}
    print(json.dumps({"pid": pid, "alive": bool(pid and pid_alive(pid)), "health": health}, indent=2))
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: gateway_supervisor.py start|stop|status", file=sys.stderr)
        return 64
    cmd = argv[1]
    if cmd == "start":
        return start()
    if cmd == "stop":
        return stop()
    if cmd == "status":
        return status()
    print(f"unknown subcommand: {cmd}", file=sys.stderr)
    return 64


if __name__ == "__main__":
    # gateway_client.py sits in the same dir; make it importable when this
    # script is invoked by path (the usual hook entrypoint pattern).
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main(sys.argv))
