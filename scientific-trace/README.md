# Scientific Trace

The `scientific-trace` module of Organic Synthesis Scientific Evaluation: a
DeepSeek Harness plugin. Distributed from Git; not published to npm.

> **Configuration is required before first use.** `scientific_run` needs two
> directories. Until you set them, every call fails with a message naming the
> missing keys. See [Configure](#configure-required) below — it takes one edit.

This bundle adds `scientific_run` to DeepSeek Harness. Calling the tool runs an
explicit four-stage scientific workflow: experience planning → planning and tool
selection → Python execution → checkpoint and routing. Its portable JavaScript
core can also be embedded in another runner by supplying model and tool callbacks.

The workflow ports the state transitions and trace layers of the supplied Python
`traced_agent.py`. It uses a native JavaScript controller rather than depending on
LangGraph. It installs an explicitly invoked scientific solver; it does not replace
the host's default agent driver globally. The initial release targets text tasks.

## Requirements

- Node.js 24.9 or later; DeepSeek Harness **0.2.2-rc.1** is the release the test
  suite was run against. The manifest also accepts 0.2.1-rc.2 and later 0.2.x
  releases; runs on those are untested.
- Python 3.10 or later and any scientific libraries needed by the task tools.
- A model provider configured in the host. The plugin uses the calling agent's
  selected model unless the plugin configuration specifies a route.
- A trusted task directory and a separate writable log directory.

## Install

From the Harness **Plugins → Add plugin** dialog, paste the install spec:

```text
git+https://github.com/<owner>/organic-synthesis-scientific-evaluation.git#<40-character-commit>&path:/scientific-trace
```

Or from a shell:

```sh
dsh plugin --profile <your-profile> add "git+https://github.com/<owner>/organic-synthesis-scientific-evaluation.git#<40-character-commit>&path:/scientific-trace"
```

This plugin is one module of a larger repository, so `path:/scientific-trace`
selects its directory. Pin the full commit; a branch or tag name also works but is
not reproducible.

## Configure (required)

Add a row override to the profile's `cordis.patch.yml`. This is the same file
where the row can be toggled; add a new entry, do not edit the bundle's own patch.

```yaml
- id: scientific-agent
  config:
    taskRoot: /absolute/path/to/trusted-tasks
    logRoot: /absolute/path/to/scientific-logs
    python: python3
```

| Key | Required | Meaning |
|---|---|---|
| `taskRoot` | yes | Directory holding task folders. A task name resolves inside it; paths leaving it are rejected. |
| `logRoot` | yes | Directory that receives `scientific_trace.json`, `trajectory.json` and `science-events.jsonl` per run. Must be writable. |
| `python` | no | Python interpreter, default `python3`. |
| `maxIterations` | no | Planning iterations, default 15. |
| `parseRetries` | no | Model output parse retries, default 3. |
| `requestTimeoutMs` | no | Per model request, default 300000. |
| `toolTimeoutMs` | no | Per Python tool call, default 120000. |
| `runTimeoutMs` | no | Whole run, default 1800000. |
| `provider`, `model`, `reasoningEffort`, `maxTokens` | no | Override the calling agent's route. Omit to inherit it. |

### Try it immediately

The package ships a working example task in `examples/minimal`. Copy that
directory into `taskRoot` as a folder named `minimal`, then call the tool with:

```json
{"task": "minimal"}
```

Expected: the tool computes the mean and sample standard deviation of 3, 6, 9
and writes `results/summary.json` inside the run's log directory. This confirms
the Python worker, the model route, and both configured paths in one call.

## Legacy tarball install

`npm pack` in this checkout, then install the resulting tarball:

```sh
dsh plugin --profile science add /absolute/path/dsh-scientific-agent-0.1.0.tgz
```

Configuration is identical to the section above.

## Usage

Call the tool with a task name relative to `taskRoot`:

```json
{"task": "my-task"}
```

An optional `run_id` resumes a previous run by its UUID. Pass `provider`, `model`,
`reasoningEffort`, and `maxTokens` in the plugin config, never as tool arguments;
keep credentials in the host's credential configuration.

## Task contract

```text
my-task/
  instruction.md
  tool_definitions.json
  tools.py
  data/                         # optional input data
  prompt_templates.json         # optional experience/planning template strings
  reference_cases.json          # optional [{"id": "case-id", ...}]
  scientific-agent.json         # optional domain/type and requiredArtifacts
```

The tool definition format follows the original runner:

```json
[
  {
    "name": "calculate",
    "description": "Perform the requested scientific calculation",
    "module": "tools",
    "function_name": "calculate",
    "parameters": {
      "type": "object",
      "properties": {"x": {"type": "number"}},
      "required": ["x"]
    }
  }
]
```

Python modules must reside inside the task directory. The worker keeps module
state between calls, supporting a task-local persistent REPL. Declared argument
types are checked; undeclared parameters and unknown tools are rejected rather
than silently filtered. The supported argument-schema subset is primitive types,
objects, arrays, required fields, and enums; this is not a complete JSON Schema
implementation. Use task-owned validation for additional constraints.

`prompt_templates.json` has `experience` and `planning` string fields using the
original Python-style placeholders and escaped `{{`/`}}` braces. When absent,
generic scientific prompts are used. No reference cases are fabricated: an absent
case file means an empty reference library. Model-claimed case IDs are validated.

`scientific-agent.json` can contain:

```json
{
  "taskDomain": "scientific_computing",
  "taskType": "dataset_analysis",
  "requiredArtifacts": ["results/result.json"]
}
```

Required JSON artifacts must exist and parse before a final answer is accepted.
Scientific/numeric correctness still requires an external task verifier.

## Traces and recovery

Each run receives a UUID and a separate directory under `logRoot`:

- `scientific_trace.json`: experience, planning, selection, execution, metrics.
- `trajectory.json`: ATIF-v1.0 for Harbor-compatible trajectory consumers.
- `science-events.jsonl`: model-attempt boundaries and full canonical tool results.
- `checkpoint.json`: authoritative atomic checkpoint, including task fingerprint.
- `answer.txt`: the final answer, empty until one is accepted.

Every parsing attempt is retained and counted. An invalid response never becomes
an empty-name tool execution. Tool arguments are recorded as actually dispatched.
The execution trace's text preview is bounded; the event journal preserves the
returned canonical value. Reported token counters come from the provider; replay
tests report zero newly consumed tokens. `answer_correct` remains `null` until an
external evaluator supplies a result outside this agent.

Resume with `{"task":"my-task","run_id":"<previous UUID>"}`. Task input
fingerprints, model, and the original total iteration budget must agree. Completed
tool calls are not replayed. The Python worker restarts, so prior in-memory
variables are lost; the planner is explicitly told to reconstruct needed state
from input data and existing artifacts. A tool interrupted with unknown side
effects blocks automatic resume. Corrupted checkpoints and active-run locks also
fail visibly. This provides progress recovery, not process-memory restoration.

The evaluator stage matches the original implementation: checkpoint and routing.
An independent scientific critic is not added implicitly.

## Execution boundary

Task tools are trusted executable Python code with local process privileges. The
task-root check prevents selecting another task path; it does not sandbox Python
code. Use a Harbor container or another external execution boundary for untrusted
tasks. Inner Python calls are logged by this plugin, while the host's tool policy
sees the enclosing `scientific_run` call. Model requests pass through the host's
LLM service. The worker receives a small environment allowlist, excluding model
credentials. Timeout/cancellation terminates and awaits the worker. Process-group
termination is attempted on POSIX; embedded hosts may only permit direct-child
termination, so external runtimes must own descendant cleanup.

The task fingerprint covers the instruction, tool definitions, direct tool-module
sources, prompt/case/settings files, and files under `data/`. External network
resources and transitive imported packages are not included.

## Verification

```sh
npm test
DSH_HOST_DIR=/path/to/test-host node test/host-integration.mjs
```

The host test uses real Cordis/LLM/tool services and deterministic responses.
BAT20 replay executes real Python against fresh inputs, but uses historical model
responses. Its fixtures are excluded from the package. A separate fresh-model
test is required by the release gate; replay is never substituted for it.

See `VERIFICATION.json` for actual check status. No benchmark-wide improvement or
cross-platform certification is claimed.

## Distribution

This plugin is distributed from its Git repository, not npm. Install by pinning a
commit as shown in [Install](#install). `npm run prepublishOnly` still guards a
future registry release and fails while required release checks are incomplete.

Never commit API keys, task answers, historical runs, or local credential files.
