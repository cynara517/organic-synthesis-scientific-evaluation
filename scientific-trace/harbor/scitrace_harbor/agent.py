"""Harbor custom agent that runs the scientific-trace core inside the task container.

    PYTHONPATH=<plugin>/harbor harbor run -p ./catalaphile-harbor \
        -a scitrace_harbor.agent:ScientificTraceAgent \
        -m openai/claude-fable-5.1 --ak model_key=claude-fable-5.1 \
        --ae HARBOR_TASK_DIR=$PWD/catalaphile-harbor \
        --ae SCI_BASE_URL=https://gateway/v1 --ae SCI_API_KEY=sk-... \
        --allow-agent-host gateway.example.com

The agent:
  * install():  installs Node.js (>=20) in the container, uploads the plugin
                (src/, python/, bin/).
  * run():      converts the Harbor package to a plugin task dir (or uses
                --ak task_adapter_dir), uploads it to /app/.scitrace_task, then runs
                bin/run-scitrace.mjs with cwd=/app so the model's python/shell
                tools operate on /app (where Harbor collects answer.json/geometries).
  * populate_context_post_run(): reads scientific_trace.json from /logs/agent and
                fills token counts; trajectory.json is already ATIF (plugin output).
"""

from __future__ import annotations

import json
import shlex
import subprocess
import sys
from pathlib import Path

from pydantic import Field

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

# Default plugin checkout: this file lives at <plugin>/harbor/scitrace_harbor/agent.py
_DEFAULT_PLUGIN_DIR = Path(__file__).resolve().parents[2]

REMOTE_PLUGIN = "/installed-agent/scientific-trace"
REMOTE_RUNNER = f"{REMOTE_PLUGIN}/bin/run-scitrace.mjs"
REMOTE_TASK = "/app/.scitrace_task"
NODE_MAJOR = "22"


class ScientificTraceOptions(InstalledAgentOptions):
    plugin_dir: str = Field(default=str(_DEFAULT_PLUGIN_DIR), description="Host path to the scientific-trace plugin checkout (contains src/, python/, bin/).")
    task_adapter_dir: str | None = Field(default=None, description="Pre-converted task dir (instruction.md, tool_definitions.json, tools.py). Omit to convert the Harbor task on the fly with bin/harbor-task-to-scitrace.py.")
    model_key: str | None = Field(default=None, description="Human-readable model key for run_meta.json (default: model name).")
    wire_model: str | None = Field(default=None, description="Model id sent to the API (default: model name without provider prefix).")
    question: str | None = Field(default=None, description="Question label in run_meta.json (default: task name).")
    max_iterations: int = Field(default=250, description="Planning iterations.")
    run_timeout_sec: int = Field(default=21000, description="Whole-run timeout inside the container (keep < task agent timeout).")
    tool_timeout_sec: int = Field(default=7200, description="Per tool-call timeout.")
    request_timeout_sec: int = Field(default=600, description="Per model request timeout.")
    max_tokens: int = Field(default=16384, description="Max output tokens per request.")
    workdir: str = Field(default="/app", description="Container dir the task writes answer.json into.")
    python: str = Field(default="python3", description="Python interpreter inside the container.")


class ScientificTraceAgent(BaseInstalledAgent):
    capabilities = AgentCapabilities(atif=True, reasoning_effort=True)
    options_model = ScientificTraceOptions
    options: ScientificTraceOptions

    @staticmethod
    def name() -> str:
        return "scientific-trace"

    def version(self) -> str | None:
        return self._version or "0.1.0"

    # ---- install -------------------------------------------------------
    async def install(self, environment: BaseEnvironment) -> None:
        plugin_dir = Path(self.options.plugin_dir).expanduser().resolve()
        if not (plugin_dir / "src" / "core.js").is_file():
            raise FileNotFoundError(f"plugin_dir has no src/core.js: {plugin_dir}")
        await self.ensure_system_dependencies(environment, ("curl", "bash", "ca_certificates", "xz", "tar"))
        # Node 22 binary tarball (works on python:3.11-slim; no apt nodejs needed).
        await self.exec_as_root(
            environment,
            command=(
                "set -e; if command -v node >/dev/null 2>&1 && [ \"$(node -p 'process.versions.node.split(\".\")[0]')\" -ge 20 ]; then exit 0; fi; "
                "arch=$(uname -m); case $arch in x86_64) a=x64;; aarch64|arm64) a=arm64;; *) echo unsupported $arch; exit 1;; esac; "
                f"ver=$(curl -fsSL https://nodejs.org/dist/latest-v{NODE_MAJOR}.x/ | grep -o 'node-v[0-9.]*-linux-'$a'.tar.xz' | head -1); "
                "curl -fsSL https://nodejs.org/dist/latest-v" + NODE_MAJOR + ".x/$ver -o /tmp/node.tar.xz && "
                "mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 && rm /tmp/node.tar.xz && "
                "ln -sf /opt/node/bin/node /usr/local/bin/node && node --version"
            ),
            timeout_sec=900,
        )
        await self.exec_as_root(environment, command=f"rm -rf {REMOTE_PLUGIN} && mkdir -p {REMOTE_PLUGIN}")
        for sub in ("src", "python", "bin"):
            await environment.upload_dir(plugin_dir / sub, f"{REMOTE_PLUGIN}/{sub}")
        await environment.upload_file(plugin_dir / "package.json", f"{REMOTE_PLUGIN}/package.json")
        await self.exec_as_root(environment, command=f"chmod -R a+rX /installed-agent && node --check {REMOTE_RUNNER}")

    # ---- run -----------------------------------------------------------
    def _model_env(self) -> dict[str, str]:
        if not self.model_name:
            raise ValueError("--model is required (e.g. openai/claude-fable-5.1)")
        wire = self.options.wire_model or (self.model_name.split("/", 1)[1] if "/" in self.model_name else self.model_name)
        key = self.options.model_key or wire
        env = {
            "SCI_PLUGIN_DIR": REMOTE_PLUGIN,
            "SCI_TASK_DIR": REMOTE_TASK,
            "SCI_LOG_DIR": str(self.environment_logs_dir),
            "SCI_MODEL": wire,
            "SCI_MODEL_KEY": key,
            "SCI_QUESTION": self.options.question or "catalaphile",
            "SCI_MAX_ITER": str(self.options.max_iterations),
            "SCI_RUN_TIMEOUT_SEC": str(self.options.run_timeout_sec),
            "SCI_TOOL_TIMEOUT_SEC": str(self.options.tool_timeout_sec),
            "SCI_REQ_TIMEOUT_SEC": str(self.options.request_timeout_sec),
            "SCI_MAX_TOKENS": str(self.options.max_tokens),
            "SCI_PYTHON": self.options.python,
        }
        if self.options.reasoning_effort:
            env["SCI_REASONING_EFFORT"] = self.options.reasoning_effort
        # Credentials/base URL come from --ae SCI_BASE_URL / SCI_API_KEY (or host env).
        for k, alts in {"SCI_BASE_URL": ("OPENAI_BASE_URL", "OPENAI_API_BASE"), "SCI_API_KEY": ("OPENAI_API_KEY",)}.items():
            v = self._get_env(k, *alts)
            if v:
                env[k] = v
        if "SCI_BASE_URL" not in env:
            raise ValueError("Set --ae SCI_BASE_URL=https://host/v1 (OpenAI-compatible endpoint)")
        return env

    def _task_adapter(self) -> Path:
        """Pre-converted task dir, or convert the Harbor package on the fly."""
        if self.options.task_adapter_dir:
            adapter = Path(self.options.task_adapter_dir).expanduser().resolve()
        else:
            harbor_task = self._get_env("HARBOR_TASK_DIR")
            if not harbor_task:
                raise ValueError("Pass --ak task_adapter_dir=<dir> or --ae HARBOR_TASK_DIR=<harbor task package>")
            adapter = self.logs_dir / "scitrace_task"
            converter = Path(self.options.plugin_dir).expanduser().resolve() / "bin" / "harbor-task-to-scitrace.py"
            subprocess.run([sys.executable, str(converter), harbor_task, str(adapter),
                            "--workdir", self.options.workdir, "--max-steps", str(self.options.max_iterations)],
                           check=True)
        for req in ("instruction.md", "tool_definitions.json", "tools.py"):
            if not (adapter / req).is_file():
                raise FileNotFoundError(f"task adapter dir missing {req}: {adapter}")
        return adapter

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        adapter = self._task_adapter()
        workdir = self.options.workdir
        await self.exec_as_root(environment, command=f"rm -rf {REMOTE_TASK} && mkdir -p {REMOTE_TASK} {self.environment_logs_dir}")
        await environment.upload_dir(adapter, REMOTE_TASK)
        # Harbor's (possibly templated) instruction wins over the adapter copy, so
        # the model sees exactly what Harbor would give any other agent.
        await self._upload_config_text(environment, content=instruction, remote_path=f"{REMOTE_TASK}/instruction.md", filename="instruction.md")
        user = environment.default_user
        if user is not None:
            await self.exec_as_root(environment, command=f"chown -R {shlex.quote(str(user))} {REMOTE_TASK} {self.environment_logs_dir}")
        env = self._model_env()
        env["SCI_WORKDIR"] = workdir
        await self.exec_as_agent(
            environment,
            command=(
                f"cd {shlex.quote(workdir)} && node {REMOTE_RUNNER} 2>&1 | tee -a {self.environment_logs_dir}/runner.stdout.log"
            ),
            env=env,
            cwd=workdir,
            timeout_sec=self.options.run_timeout_sec + 600,
        )

    # ---- post-run ------------------------------------------------------
    def populate_context_post_run(self, context: AgentContext) -> None:
        trace_path = self.logs_dir / "scientific_trace.json"
        if not trace_path.exists():
            return
        try:
            trace = json.loads(trace_path.read_text())
        except Exception as exc:  # noqa: BLE001
            self.logger.debug(f"cannot parse scientific_trace.json: {exc}")
            return
        m = trace.get("summary_metrics") or {}
        context.n_input_tokens = int(m.get("total_input_tokens") or 0)
        context.n_output_tokens = int(m.get("total_output_tokens") or 0)
        context.n_cache_tokens = int(m.get("total_cache_read_tokens") or 0)
        context.metadata = {
            "status": trace.get("status"),
            "total_steps": trace.get("total_steps"),
            "total_llm_calls": m.get("total_llm_calls"),
            "agent_model": trace.get("agent_model"),
        }
