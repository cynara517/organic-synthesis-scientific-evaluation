# Running scientific-trace on Harbor tasks

> Append this section to `scientific-trace/README.md` (after "Task contract"), or
> keep it as a separate file. It documents the second adapter layer added to the
> plugin. The DeepSeek Harness adapter (`src/plugin.js`, `src/host-model.js`) is
> unchanged; both adapters share `src/core.js`, `src/python-tools.js`, `src/task.js`.

## Layout

```text
scientific-trace/
  src/                      shared core + DeepSeek Harness adapter   (unchanged)
  python/worker.py          Python tool worker                        (unchanged)
  bin/run-scitrace.mjs      standalone runner: core + OpenAI-compatible endpoint
  bin/harbor-task-to-scitrace.py
                            Harbor task package -> plugin task directory
  tasks/harbor-generic/     tool_definitions.json, tools.py, prompt_templates.json
                            (python_exec / write_file / read_file / shell_exec; the
                            historical runner's prompt wording so traces stay comparable)
  harbor/scitrace_harbor/   Harbor custom agent (BaseInstalledAgent subclass)
  harbor/run_catalaphile.sh one `harbor run` per model
  harbor/collect_runs.py    Harbor job dirs -> bench_runs_1/<model>/<question>/ layout
```

## One change to the core

`src/core.js` now accepts `final_answer` as a JSON **object** as well as a string.
The historical runner's planning prompt asks for `"final_answer": <exact JSON
object>`, and every past trace stores an object `{"answer": ..., "reasoning": ...}`.
`answer.txt` receives the object serialised with `JSON.stringify`. String answers
behave exactly as before; the 18 upstream tests still pass.

## Standalone runner (no Harness host)

```sh
SCI_PLUGIN_DIR=$PWD SCI_TASK_DIR=/path/to/task SCI_LOG_DIR=/path/to/log \
SCI_MODEL=claude-fable-5.1 SCI_BASE_URL=https://gateway/v1 SCI_API_KEY=... \
SCI_MAX_ITER=250 node bin/run-scitrace.mjs
```

The runner imports `src/core.js` directly, posts each prompt to
`$SCI_BASE_URL/chat/completions` (non-streaming, 4 retries on 429/5xx), and writes
the plugin's normal `scientific_trace.json` / `trajectory.json` / `answer.txt` /
`science-events.jsonl` plus the legacy `run_meta.json`, `agent_status.json` and
`run.log` (`[llm] step=N …` lines) used by the earlier benchmark tooling.
All knobs are environment variables; see the header of the script.

## Harbor custom agent

```sh
uv tool install harbor                  # Harbor >= 0.26, needs Python >= 3.12
export PYTHONPATH=$PWD/harbor
harbor run -p /path/to/catalaphile-harbor \
  -a scitrace_harbor.agent:ScientificTraceAgent \
  -m openai/claude-fable-5.1 --ak model_key=claude-fable-5.1 \
  --ae HARBOR_TASK_DIR=/path/to/catalaphile-harbor \
  --ae SCI_BASE_URL=https://gateway/v1 --ae SCI_API_KEY=... \
  --allow-agent-host gateway.example.com
```

`install()` puts Node 22 and the plugin (`src/ python/ bin/`) under
`/installed-agent/` in the task container. `run()` converts the Harbor package with
`bin/harbor-task-to-scitrace.py` (or takes `--ak task_adapter_dir=`), uploads it to
`/app/.scitrace_task`, and launches the runner with `cwd=/app`. The generic
`tools.py` `chdir`s to the `workdir` recorded in `scientific-agent.json` (`/app`), so
`answer.json` and `geometries/` land where `task.toml` `artifacts` collects them.
Token counts are back-filled into Harbor's `AgentContext` from
`scientific_trace.json`; `trajectory.json` is already ATIF.

Options (`--ak key=value`): `plugin_dir` (default: this checkout), `task_adapter_dir`,
`model_key`, `wire_model`, `question`, `max_iterations` (250), `run_timeout_sec`
(21000), `tool_timeout_sec` (7200), `request_timeout_sec` (600), `max_tokens`
(16384), `workdir` (/app), `python`, `reasoning_effort`.

Network: the catalaphile package is `network_mode = "no-network"`; pass
`--allow-agent-host <gateway host>` so only the inference endpoint is reachable
during the agent phase. If the Node download in `install()` is blocked, add
`--allow-environment-host nodejs.org` or pre-install Node in the task image and use
`--ak skip_install=true`.

## Verified

* `examples/minimal` through the standalone runner with a stub model: `completed`.
* `example/catalaphile-harbor` (this repository): the Harbor package converted with
  `bin/harbor-task-to-scitrace.py`, driven by a scripted model that exercises all four
  tools, produced `/app/answer.json` + 24 geometries; `tests/checker.py` with the
  task's xTB 6.7.1 build returned `reward 1.0` (T = 0.1634, RMSD 0.269 / 1.2325 Å).
* `harbor.utils.import_path.import_class` loads `scitrace_harbor.agent:ScientificTraceAgent`
  under Harbor 0.26.0; `preflight`, option parsing and on-the-fly task conversion pass.
* Not yet exercised: a real `harbor run` inside Docker (needs a host with Docker).
