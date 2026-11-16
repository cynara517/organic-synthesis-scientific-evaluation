"""Persistent task-local tool worker. JSONL stdout is reserved for the bridge.

Task modules are executable trusted code. This worker is NOT a security sandbox;
untrusted tasks require an external container such as a Harbor task environment.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import traceback

PROTOCOL = sys.stdout
task = Path(sys.argv[1]).resolve(strict=True)
os.chdir(task)
sys.path.insert(0, str(task))
tools = {}
loaded_modules = {}


def emit(value):
    PROTOCOL.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
    PROTOCOL.flush()


def load():
    definitions = json.loads((task / "tool_definitions.json").read_text())
    if not isinstance(definitions, list) or not definitions:
        raise ValueError("tool_definitions.json must contain a nonempty array")
    for item in definitions:
        name = item["name"]
        if name in tools:
            raise ValueError("Duplicate tool name: " + name)
        module_name = item["module"]
        if not all(part.isidentifier() for part in module_name.split(".")):
            raise ValueError("Invalid task-local module name")
        path = (task / (module_name.replace(".", "/") + ".py")).resolve(strict=True)
        if not path.is_relative_to(task):
            raise ValueError("Tool module must be inside the task directory")
        # Reuse each module object so REPL state persists even across tool names.
        if path not in loaded_modules:
            spec = importlib.util.spec_from_file_location(module_name, path)
            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            spec.loader.exec_module(module)
            loaded_modules[path] = module
        fn = getattr(loaded_modules[path], item["function_name"])
        tools[name] = (fn, item)
    return [{k: item[k] for k in ("name", "description", "parameters")} for _, item in tools.values()]


try:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        schemas = load()
    emit({"type": "ready", "tools": schemas})
except Exception as exc:
    emit({"type": "startup_error", "error": f"{type(exc).__name__}: {exc}"})
    sys.exit(1)

for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        fn, definition = tools[request["name"]]
        args = request["arguments"]
        if not isinstance(args, dict):
            raise ValueError("Tool arguments must be an object")
        # Parameter validation belongs to the JS bridge. Never silently filter.
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            value = fn(**{**definition.get("fixed_kwargs", {}), **args})
        json.dumps(value, allow_nan=False)
        reported_error = None
        if isinstance(value, str) and value.lstrip().startswith(("Traceback (most recent call last):", "Error:", "ERROR:")):
            reported_error = "Task tool reported an error in its textual result"
        emit({"id": request["id"], "value": value, "stdout": captured.getvalue(), "error": reported_error})
    except Exception as exc:
        emit({"id": request.get("id") if isinstance(request, dict) else None,
              "value": None, "stdout": "", "error": f"{type(exc).__name__}: {exc}"})
