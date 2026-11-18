"""Generic tool module for Harbor-style tasks (python_exec / write_file / read_file / shell_exec).

Mirrors the four tools of the historical ``traced_agent.py`` runner so traces are
comparable with earlier benchmark runs. The working directory is read from
``scientific-agent.json`` (key ``workdir``) next to this file; it defaults to the
task directory. In a Harbor container the converter sets it to ``/app`` so the
agent's files land where ``task.toml`` ``artifacts`` collects them.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import traceback
from pathlib import Path

_TASK_DIR = Path(__file__).resolve().parent
_SETTINGS = {}
try:
    _SETTINGS = json.loads((_TASK_DIR / "scientific-agent.json").read_text(encoding="utf-8"))
except (OSError, ValueError):
    pass
WORKDIR = Path(_SETTINGS.get("workdir") or _TASK_DIR).resolve()
WORKDIR.mkdir(parents=True, exist_ok=True)
os.chdir(WORKDIR)
if str(WORKDIR) not in sys.path:
    sys.path.insert(0, str(WORKDIR))

PY_CAP = int(_SETTINGS.get("pythonOutputCap", 12_000))
SH_CAP = int(_SETTINGS.get("shellOutputCap", 8_000))
READ_CAP_DEFAULT = int(_SETTINGS.get("readDefaultChars", 10_000))
SHELL_TIMEOUT_DEFAULT = int(_SETTINGS.get("shellTimeoutSec", 300))

_NAMESPACE: dict = {"__name__": "__main__", "__builtins__": __builtins__}


def _cap(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [truncated {len(text) - limit} chars]"


def _resolve(path: str) -> Path:
    p = Path(path).expanduser()
    return p if p.is_absolute() else WORKDIR / p


def python_exec(code: str) -> str:
    """Execute Python code in a persistent namespace shared across calls."""
    buf = io.StringIO()
    os.chdir(WORKDIR)
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        try:
            exec(compile(code, "<python_exec>", "exec"), _NAMESPACE)
        except SystemExit as exc:  # keep the worker alive
            buf.write(f"SystemExit: {exc.code}\n")
        except BaseException:  # noqa: BLE001 - report everything to the model
            buf.write(traceback.format_exc())
    out = buf.getvalue()
    return _cap(out if out.strip() else "(no output)", PY_CAP)


def write_file(path: str, content: str) -> str:
    """Write text to a file, creating parent directories."""
    target = _resolve(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"wrote {len(content)} chars to {target}"


def read_file(path: str, max_chars: int = READ_CAP_DEFAULT) -> str:
    """Read a text file (up to max_chars)."""
    target = _resolve(path)
    if not target.exists():
        return f"Error: file not found: {target}"
    if target.is_dir():
        entries = sorted(p.name + ("/" if p.is_dir() else "") for p in target.iterdir())
        return _cap("\n".join(entries), max_chars)
    data = target.read_text(encoding="utf-8", errors="replace")
    return _cap(data, max(1, int(max_chars)))


def shell_exec(command: str, timeout: int = SHELL_TIMEOUT_DEFAULT) -> str:
    """Run a shell command in the working directory; returns combined stdout+stderr."""
    try:
        proc = subprocess.run(
            command, shell=True, cwd=str(WORKDIR), text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=max(1, int(timeout)), executable="/bin/bash",
        )
    except subprocess.TimeoutExpired as exc:
        partial = (exc.stdout or b"")
        if isinstance(partial, bytes):
            partial = partial.decode("utf-8", "replace")
        return _cap(f"Error: command timed out after {timeout}s\n{partial}", SH_CAP)
    out = proc.stdout or ""
    if proc.returncode != 0:
        out += f"\n[exit code {proc.returncode}]"
    return _cap(out if out.strip() else f"(no output) [exit code {proc.returncode}]", SH_CAP)
