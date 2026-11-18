# Scientific Trace

**A scientific-reasoning agent that records *why* it did each step, not just *what* it ran.**

Most agent frameworks hand you a flat ATIF trajectory: a list of prompts, tool calls
and observations. That is enough to replay a run, but not to judge the science in it.
Scientific Trace runs the agent through an explicit four-stage loop and writes a
second, structured record alongside the ATIF file:

```text
experience planning  →  planning & tool selection  →  Python execution  →  checkpoint & routing
        │                        │                          │                    │
  task_understanding     current_objective            call_params          evaluator
  initial_plan           current_understanding        result_summary       status / resume
  reference_cases_used   planning_rationale           runtime_metrics
                         plan_adjustment
                         selection_reasoning
                         alternative_considered
```

Every planning step is a JSON object the model must fill in before it may act, and
the record (`scientific_trace.json`) keeps the raw prompt, the raw response, token
counts and latency for each of them. A rubric-based judge (see
[`../judge/trace_scoring_prompt.md`](../judge/trace_scoring_prompt.md)) can then score
*scientific method quality*, something a bare ATIF log cannot support.

It runs in two ways:

| | **1 · Harbor** | **2 · DeepSeek Harness** |
|---|---|---|
| What it is | A Harbor custom agent (`-a scitrace_harbor.agent:ScientificTraceAgent`) | A Harness plugin registering the `scientific_run` tool |
| Takes as input | Any **standard Harbor task package** (`instruction.md` + `task.toml` + `environment/` + `tests/`) | A task directory in the plugin's own contract (below) |
| Model access | Any OpenAI-compatible endpoint, configured per run | The model route the Harness user already selected |
| Output | ATIF `trajectory.json` for Harbor **plus** `scientific_trace.json` | The same two files, under `logRoot/<run-id>/` |
| Grading | Harbor verifier (task's own `tests/`) | External; `answer_correct` stays `null` |

Both paths share the same core (`src/core.js`, `src/python-tools.js`, `src/task.js`,
`python/worker.py`). Nothing is duplicated; only the way the model is reached and the
way the task is loaded differ.

---

## 1 · Harbor: run a standard task package

**Requirements.** Docker, and Harbor ≥ 0.26 (`uv tool install harbor`; needs
Python ≥ 3.12). Node.js is installed *inside* the task container by the agent.

```sh
git clone https://github.com/cynara517/organic-synthesis-scientific-evaluation.git
export PYTHONPATH=$PWD/organic-synthesis-scientific-evaluation/scientific-trace/harbor

harbor run -p /path/to/catalaphile-harbor \
  -a scitrace_harbor.agent:ScientificTraceAgent \
  -m openai/claude-fable-5.1 --ak model_key=claude-fable-5.1 \
  --ae HARBOR_TASK_DIR=/path/to/catalaphile-harbor \
  --ae SCI_BASE_URL=https://<gateway>/v1 --ae SCI_API_KEY=... \
  --allow-agent-host <gateway host>
```

What happens:

1. **install** — the agent puts Node 22 and this plugin under `/installed-agent/` in the task container.
2. **convert** — `bin/harbor-task-to-scitrace.py` turns the Harbor package into a plugin task directory: `instruction.md` verbatim, plus the generic tool set from `tasks/harbor-generic/` (`python_exec`, `write_file`, `read_file`, `shell_exec`). Task data is not copied; the Harbor image already has it in the container workdir.
3. **run** — `bin/run-scitrace.mjs` drives the core with the given model. Tools execute with `cwd` = the task's workdir (`/app`), so `answer.json` and other deliverables land where `task.toml` `artifacts` collects them.
4. **verify** — Harbor runs the task's own `tests/` as usual.

Harbor's trial directory then contains, under `agent/`:

```text
trajectory.json          ATIF-v1.0  (what Harbor and other tools read)
scientific_trace.json    the four-stage scientific record
science-events.jsonl     full tool results and model-attempt boundaries
answer.txt               the final answer (string or JSON object)
run_meta.json, agent_status.json, run.log      run-level summary
```

Agent options (`--ak key=value`): `model_key`, `wire_model`, `question`,
`max_iterations` (250), `run_timeout_sec` (21000), `tool_timeout_sec` (7200),
`request_timeout_sec` (600), `max_tokens` (16384), `reasoning_effort`, `workdir`
(/app), `task_adapter_dir` (skip conversion and use a prepared task dir),
`plugin_dir` (default: this checkout).

Network: Harbor tasks are often `network_mode = "no-network"`. `--allow-agent-host`
opens only the inference endpoint during the agent phase. If the Node download in
*install* is blocked, add `--allow-environment-host nodejs.org`, or bake Node into the
task image and pass `--ak skip_install=true`.

`harbor/run_catalaphile.sh` runs one task across a list of models;
`harbor/collect_runs.py` reorganises Harbor job output into
`bench_runs_1/<model>/<question>/` with `reward × 100` as the answer score.

A worked example with a real Harbor package and a verified `reward 1.0` run is in
[`../example/catalaphile-harbor`](../example/catalaphile-harbor).

### Standalone (no Harbor, no Harness)

The same runner works on its own against any OpenAI-compatible endpoint:

```sh
python3 bin/harbor-task-to-scitrace.py /path/to/harbor-task /tmp/task --workdir /tmp/app
SCI_PLUGIN_DIR=$PWD SCI_TASK_DIR=/tmp/task SCI_LOG_DIR=/tmp/log \
SCI_MODEL=claude-fable-5.1 SCI_BASE_URL=https://<gateway>/v1 SCI_API_KEY=... \
node bin/run-scitrace.mjs
```

All knobs are environment variables; the header of `bin/run-scitrace.mjs` lists them.

---

## 2 · DeepSeek Harness: install as a plugin

**Requirements.** Node.js ≥ 24.9, DeepSeek Harness 0.2.2-rc.1 (manifest also accepts
0.2.1-rc.2 and later 0.2.x), Python ≥ 3.10 with whatever the task tools import, and a
model provider already configured in the Harness.

**Install** from *Plugins → Add plugin*, or:

```sh
dsh plugin --profile <profile> add \
  "git+https://github.com/cynara517/organic-synthesis-scientific-evaluation.git#<40-char-commit>&path:/scientific-trace"
```

`path:/scientific-trace` selects this directory of the monorepo. Pin a full commit.

**Configure** (required) — add a row override to the profile's `cordis.patch.yml`:

```yaml
- id: scientific-agent
  config:
    taskRoot: /absolute/path/to/trusted-tasks
    logRoot: /absolute/path/to/scientific-logs
    python: python3
```

| Key | Required | Meaning |
|---|---|---|
| `taskRoot` | yes | Directory holding task folders; paths leaving it are rejected. |
| `logRoot` | yes | Receives `scientific_trace.json`, `trajectory.json`, `science-events.jsonl` per run. |
| `python` | no | Interpreter, default `python3`. |
| `maxIterations` | no | Planning iterations, default 15. |
| `parseRetries` | no | Model-output parse retries, default 3. |
| `requestTimeoutMs` / `toolTimeoutMs` / `runTimeoutMs` | no | 300 000 / 120 000 / 1 800 000. |
| `provider`, `model`, `reasoningEffort`, `maxTokens` | no | Override the calling agent's route. Omit to inherit it. |

**Try it.** Copy `examples/minimal/` into `taskRoot` as `minimal`, then call the tool:

```json
{"task": "minimal"}
```

It computes the mean and sample standard deviation of 3, 6, 9 and writes
`results/summary.json` in the run's log directory. An optional `run_id` resumes a
previous run. Credentials stay in the Harness; never pass them as tool arguments.

---

## Task contract (what the core loads)

Both paths end up loading a directory of this shape — written by hand for the Harness
path, generated by `bin/harbor-task-to-scitrace.py` for the Harbor path:

```text
my-task/
  instruction.md             the task text
  tool_definitions.json      [{name, description, module, function_name, parameters}]
  tools.py                   Python implementations (module named in each tool)
  data/                      optional input data (fingerprinted)
  prompt_templates.json      optional {experience, planning} templates
  reference_cases.json       optional [{"id": ...}]
  scientific-agent.json      optional {taskDomain, taskType, requiredArtifacts, workdir}
```

Tool argument schemas support primitives, objects, arrays, `required` and `enum`;
undeclared parameters and unknown tools are rejected rather than filtered. Python
module state persists across calls (a task-local REPL). `requiredArtifacts` are JSON
files inside the task directory that must exist and parse before a final answer is
accepted.

`tasks/harbor-generic/` holds the generic tool set and the prompt templates used for
Harbor runs. The templates reproduce the wording of the earlier benchmark runner so
traces from both are comparable under the same judge rubric.

## Traces and recovery

Each run has a UUID and a directory under the log root:

* `scientific_trace.json` — experience planning, per-step planning / tool selection / execution records, summary metrics, status.
* `trajectory.json` — ATIF-v1.0 for Harbor-compatible consumers.
* `science-events.jsonl` — model-attempt boundaries and full canonical tool results.
* `checkpoint.json` — authoritative atomic checkpoint with task fingerprint.
* `answer.txt` — the final answer; a string, or a JSON object serialised as given.

Every parsing attempt is retained and counted. Resume with `{"task": ..., "run_id": ...}`;
fingerprint, model and iteration budget must agree, completed tool calls are not
replayed, and a tool interrupted with unknown side effects blocks automatic resume.

## Execution boundary

Task tools are trusted Python with local process privileges. The task-root check stops
a run from selecting another task's directory; it does not sandbox Python. Use a Harbor
container (path 1) or another external boundary for untrusted tasks. The worker receives
a small environment allowlist without model credentials.

## Verification

```sh
npm test                                           # 18 core tests
DSH_HOST_DIR=/path/to/test-host node test/host-integration.mjs
```

Verified so far: the `examples/minimal` task through both paths; the
`example/catalaphile-harbor` Harbor package converted, run end to end and graded
`reward 1.0` by its own verifier; the Harbor agent class loads under Harbor 0.26.0.
Not yet exercised: `harbor run` inside Docker on a real host. See `VERIFICATION.json`
for the recorded check status.

## Layout

```text
src/core.js, python-tools.js, task.js, prompts.js   shared core
python/worker.py                                     Python tool worker
src/plugin.js, host-model.js, cordis.patch.yml       DeepSeek Harness adapter
bin/run-scitrace.mjs                                 standalone runner (OpenAI-compatible endpoint)
bin/harbor-task-to-scitrace.py                       Harbor package → task directory
tasks/harbor-generic/                                generic tools + benchmark prompt templates
harbor/scitrace_harbor/                              Harbor custom agent
harbor/run_catalaphile.sh, collect_runs.py           batch run / collect helpers
examples/minimal/                                    smallest hand-written task
```

Distributed from Git, not npm. Never commit API keys, task answers or run artefacts.
MIT License.
