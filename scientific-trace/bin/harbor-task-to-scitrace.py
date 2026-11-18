#!/usr/bin/env python3
"""Convert a Harbor task package into a scientific-trace task directory.

    harbor-task-to-scitrace.py <harbor_task_dir> <out_task_dir> [--workdir /app]
        [--max-steps 250] [--no-prompt-templates]

Harbor package (input)                 scientific-trace task (output)
  instruction.md             ->          instruction.md   (verbatim)
  task.toml  [agent].timeout ->          scientific-agent.json  {workdir, timeoutSec, requiredArtifacts: []}
  environment/data/          ->          (not copied; the Harbor image already has it at <workdir>/data)
  (plugin tasks/harbor-generic/) ->      tool_definitions.json, tools.py
  (plugin tasks/harbor-generic/) ->      prompt_templates.json  (historical runner wording)

`requiredArtifacts` is left empty on purpose: the plugin only accepts paths inside the
task directory, while Harbor collects artifacts from the container workdir
(task.toml `artifacts`). Verification is the Harbor verifier's job.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

try:
    import tomllib  # Python >= 3.11
except ModuleNotFoundError:  # pragma: no cover - minimal fallback for 3.10
    tomllib = None


def _load_toml(text: str) -> dict:
    if tomllib is not None:
        return tomllib.loads(text)
    # Minimal parser: top-level arrays of strings plus [section] key = value scalars.
    data: dict = {}
    section = data
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip() if not raw.strip().startswith("#") else ""
        if not line:
            continue
        m = re.match(r"^\[([\w.\-]+)\]$", line)
        if m:
            section = data
            for part in m.group(1).split("."):
                section = section.setdefault(part, {})
            continue
        m = re.match(r"^([\w\-]+)\s*=\s*(.+)$", line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if val.startswith("["):
            section[key] = re.findall(r'"([^"]*)"', val)
        elif val.startswith('"'):
            section[key] = val.strip('"')
        elif val in ("true", "false"):
            section[key] = val == "true"
        else:
            try:
                section[key] = float(val) if "." in val else int(val)
            except ValueError:
                section[key] = val
    return data

HERE = Path(__file__).resolve().parent
GENERIC = HERE.parent / "tasks" / "harbor-generic"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("harbor_task")
    ap.add_argument("out_dir")
    ap.add_argument("--workdir", default=None, help="container workdir (default: task.toml [environment].workdir or /app)")
    ap.add_argument("--max-steps", type=int, default=250)
    ap.add_argument("--no-prompt-templates", action="store_true", help="use the plugin's default prompts instead of the historical runner wording")
    ns = ap.parse_args()

    src = Path(ns.harbor_task).resolve()
    out = Path(ns.out_dir).resolve()
    instruction = src / "instruction.md"
    toml_path = src / "task.toml"
    if not instruction.is_file() or not toml_path.is_file():
        print(f"not a Harbor task package (need instruction.md + task.toml): {src}", file=sys.stderr)
        return 2
    cfg = _load_toml(toml_path.read_text(encoding="utf-8"))
    workdir = ns.workdir or (cfg.get("environment") or {}).get("workdir") or "/app"
    timeout = float((cfg.get("agent") or {}).get("timeout_sec") or 1800)
    artifacts = cfg.get("artifacts") or []

    out.mkdir(parents=True, exist_ok=True)
    shutil.copy2(instruction, out / "instruction.md")
    shutil.copy2(GENERIC / "tool_definitions.json", out / "tool_definitions.json")
    shutil.copy2(GENERIC / "tools.py", out / "tools.py")
    if not ns.no_prompt_templates:
        shutil.copy2(GENERIC / "prompt_templates.json", out / "prompt_templates.json")
    settings = {
        "taskDomain": (cfg.get("metadata") or {}).get("domain") or "scientific_computing",
        "taskType": (cfg.get("metadata") or {}).get("category") or "harbor_task",
        "requiredArtifacts": [],
        "workdir": workdir,
        "harbor": {
            "taskName": (cfg.get("task") or {}).get("name"),
            "agentTimeoutSec": timeout,
            "artifacts": artifacts,
            "maxSteps": ns.max_steps,
        },
    }
    (out / "scientific-agent.json").write_text(json.dumps(settings, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"task dir ready: {out}\n  workdir={workdir} timeout={timeout:g}s artifacts={artifacts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
