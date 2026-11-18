# Scientific Trace

**一个会记录"每一步为什么这样做"的科学推理 agent，而不只是记录"跑了什么"。**

多数 agent 框架给出的是一条扁平的 ATIF 轨迹：prompt、工具调用、观察结果依次排列。
这足以回放一次运行，却不足以评判其中的科学性。Scientific Trace 让 agent 按显式的四阶段
循环工作，并在 ATIF 文件之外再写一份结构化记录：

```text
经验规划  →  计划与工具选择  →  Python 执行  →  检查点与路由
    │              │                 │               │
task_understanding  current_objective     call_params      evaluator
initial_plan        current_understanding  result_summary   status / resume
reference_cases_used planning_rationale    runtime_metrics
                    plan_adjustment
                    selection_reasoning
                    alternative_considered
```

模型每一步行动之前都必须先填出这样一个 JSON 对象；记录文件
`scientific_trace.json` 为每一步保留原始 prompt、原始回复、token 数和延迟。
配合评分量规（见 [`../judge/trace_scoring_prompt.md`](../judge/trace_scoring_prompt.md)），
评审模型就可以对**科学方法的质量**打分——这是裸 ATIF 日志做不到的。

它有两种运行方式：

| | **1 · Harbor** | **2 · DeepSeek Harness** |
|---|---|---|
| 形态 | Harbor 自定义 agent（`-a scitrace_harbor.agent:ScientificTraceAgent`） | Harness 插件，注册 `scientific_run` 工具 |
| 输入 | 任意**标准 Harbor 题包**（`instruction.md` + `task.toml` + `environment/` + `tests/`） | 插件自己契约的任务目录（见下文） |
| 模型 | 任意 OpenAI 兼容端点，按次配置 | Harness 用户已选的模型路由 |
| 输出 | 给 Harbor 的 ATIF `trajectory.json` **加上** `scientific_trace.json` | 同样两份文件，位于 `logRoot/<run-id>/` |
| 判分 | Harbor verifier（题包自带 `tests/`） | 外部进行；`answer_correct` 保持 `null` |

两条路共用同一个核心（`src/core.js`、`src/python-tools.js`、`src/task.js`、
`python/worker.py`），没有重复实现；区别只在于怎样连模型、怎样加载任务。

---

## 1 · Harbor：直接运行标准题包

**需要。** Docker；Harbor ≥ 0.26（`uv tool install harbor`，需 Python ≥ 3.12）。
Node.js 由 agent 在任务容器**内部**安装，宿主机不需要。

```sh
git clone https://github.com/cynara517/organic-synthesis-scientific-evaluation.git
export PYTHONPATH=$PWD/organic-synthesis-scientific-evaluation/scientific-trace/harbor

harbor run -p /path/to/catalaphile-harbor \
  -a scitrace_harbor.agent:ScientificTraceAgent \
  -m openai/claude-fable-5.1 --ak model_key=claude-fable-5.1 \
  --ae HARBOR_TASK_DIR=/path/to/catalaphile-harbor \
  --ae SCI_BASE_URL=https://<网关>/v1 --ae SCI_API_KEY=... \
  --allow-agent-host <网关域名>
```

过程：

1. **install** —— agent 把 Node 22 和本插件放到任务容器的 `/installed-agent/`。
2. **convert** —— `bin/harbor-task-to-scitrace.py` 把 Harbor 题包转成插件任务目录：`instruction.md` 原样拷入，再配上 `tasks/harbor-generic/` 里的通用工具（`python_exec`、`write_file`、`read_file`、`shell_exec`）。题目数据不拷贝，Harbor 镜像里已经有。
3. **run** —— `bin/run-scitrace.mjs` 用指定模型驱动核心。工具以题包工作目录（`/app`）为 cwd 执行，所以 `answer.json` 等交付物会落在 `task.toml` `artifacts` 收集的位置。
4. **verify** —— Harbor 照常运行题包自己的 `tests/`。

Harbor 的 trial 目录里，`agent/` 下会有：

```text
trajectory.json          ATIF-v1.0（Harbor 及其他工具读取）
scientific_trace.json    四阶段科学记录
science-events.jsonl     完整工具结果与模型尝试边界
answer.txt               最终答案（字符串或 JSON 对象）
run_meta.json, agent_status.json, run.log      运行级摘要
```

agent 选项（`--ak key=value`）：`model_key`、`wire_model`、`question`、
`max_iterations`（250）、`run_timeout_sec`（21000）、`tool_timeout_sec`（7200）、
`request_timeout_sec`（600）、`max_tokens`（16384）、`reasoning_effort`、`workdir`
（/app）、`task_adapter_dir`（跳过转换，直接用准备好的任务目录）、`plugin_dir`（默认本检出）。

网络：Harbor 题包常设 `network_mode = "no-network"`。`--allow-agent-host` 只在 agent 阶段
放行推理端点。若 install 阶段下载 Node 被拦，加 `--allow-environment-host nodejs.org`，
或把 Node 预装进题包镜像并传 `--ak skip_install=true`。

`harbor/run_catalaphile.sh` 对一组模型逐个跑同一题；`harbor/collect_runs.py` 把
Harbor 作业输出整理成 `bench_runs_1/<model>/<question>/` 布局，答案分为 `reward × 100`。

真实 Harbor 题包的完整示例（含验证通过的 `reward 1.0` 运行）见
[`../example/catalaphile-harbor`](../example/catalaphile-harbor)。

### 独立运行（不经 Harbor，也不经 Harness）

同一个 runner 可以单独对任意 OpenAI 兼容端点运行：

```sh
python3 bin/harbor-task-to-scitrace.py /path/to/harbor-task /tmp/task --workdir /tmp/app
SCI_PLUGIN_DIR=$PWD SCI_TASK_DIR=/tmp/task SCI_LOG_DIR=/tmp/log \
SCI_MODEL=claude-fable-5.1 SCI_BASE_URL=https://<网关>/v1 SCI_API_KEY=... \
node bin/run-scitrace.mjs
```

全部参数都是环境变量，列表见 `bin/run-scitrace.mjs` 文件头。

---

## 2 · DeepSeek Harness：作为插件安装

**需要。** Node.js ≥ 24.9；DeepSeek Harness 0.2.2-rc.1（清单也接受 0.2.1-rc.2 及后续
0.2.x）；Python ≥ 3.10 及任务工具所需依赖；Harness 中已配置好模型 provider。

**安装**：在 *插件 → 添加插件* 粘贴，或在终端：

```sh
dsh plugin --profile <profile> add \
  "git+https://github.com/cynara517/organic-synthesis-scientific-evaluation.git#<40位commit>&path:/scientific-trace"
```

`path:/scientific-trace` 选中 monorepo 中的本目录。请固定到完整 commit。

**配置（必做）**：在 profile 的 `cordis.patch.yml` 增加一条行覆盖：

```yaml
- id: scientific-agent
  config:
    taskRoot: /absolute/path/to/trusted-tasks
    logRoot: /absolute/path/to/scientific-logs
    python: python3
```

| 键 | 必填 | 含义 |
|---|---|---|
| `taskRoot` | 是 | 存放任务目录的根；越界路径被拒。 |
| `logRoot` | 是 | 每次运行写入 `scientific_trace.json`、`trajectory.json`、`science-events.jsonl`。 |
| `python` | 否 | 解释器，默认 `python3`。 |
| `maxIterations` | 否 | 规划迭代数，默认 15。 |
| `parseRetries` | 否 | 模型输出解析重试，默认 3。 |
| `requestTimeoutMs` / `toolTimeoutMs` / `runTimeoutMs` | 否 | 300 000 / 120 000 / 1 800 000。 |
| `provider`、`model`、`reasoningEffort`、`maxTokens` | 否 | 覆盖调用方的模型路由；省略则继承。 |

**试一下**：把 `examples/minimal/` 复制到 `taskRoot` 下并命名为 `minimal`，然后调用：

```json
{"task": "minimal"}
```

它会计算 3、6、9 的均值与样本标准差，并在运行日志目录写出 `results/summary.json`。
可选的 `run_id` 用于恢复上一次运行。凭据留在 Harness 中，不要作为工具参数传入。

---

## 任务契约（核心加载的内容）

两条路最终都加载这样一个目录——Harness 路径手写，Harbor 路径由
`bin/harbor-task-to-scitrace.py` 生成：

```text
my-task/
  instruction.md             题面
  tool_definitions.json      [{name, description, module, function_name, parameters}]
  tools.py                   Python 实现（模块名由各工具指定）
  data/                      可选输入数据（计入指纹）
  prompt_templates.json      可选 {experience, planning} 模板
  reference_cases.json       可选 [{"id": ...}]
  scientific-agent.json      可选 {taskDomain, taskType, requiredArtifacts, workdir}
```

工具参数 schema 支持基本类型、对象、数组、`required` 与 `enum`；未声明的参数和未知工具
会被拒绝而非过滤。Python 模块状态跨调用保留（任务级 REPL）。`requiredArtifacts` 是任务目录
内的 JSON 文件，最终答案被接受前必须存在且可解析。

`tasks/harbor-generic/` 存放 Harbor 运行用的通用工具集与 prompt 模板。模板复刻了早期
基准 runner 的措辞，使两边产出的轨迹在同一评分量规下可比。

## 轨迹与恢复

每次运行有一个 UUID，在日志根下占一个目录：

* `scientific_trace.json` —— 经验规划、每步的规划 / 工具选择 / 执行记录、汇总指标、状态。
* `trajectory.json` —— ATIF-v1.0，供 Harbor 兼容消费方使用。
* `science-events.jsonl` —— 模型尝试边界与完整工具结果。
* `checkpoint.json` —— 带任务指纹的权威原子检查点。
* `answer.txt` —— 最终答案；字符串，或按原样序列化的 JSON 对象。

每次解析尝试都被保留并计数。用 `{"task": ..., "run_id": ...}` 恢复；指纹、模型、迭代预算
必须一致，已完成的工具调用不会重放，副作用未知的中断工具会阻止自动恢复。

## 执行边界

任务工具是拥有本地进程权限的可信 Python。任务根检查只防止选到别的任务目录，不隔离
Python 代码。不可信任务请用 Harbor 容器（路径 1）或其他外部边界。worker 只拿到一小份
环境变量白名单，不含模型凭据。

## 验证

```sh
npm test                                           # 18 个核心测试
DSH_HOST_DIR=/path/to/test-host node test/host-integration.mjs
```

已验证：`examples/minimal` 走通两条路径；`example/catalaphile-harbor` 的 Harbor 题包
经转换、端到端运行并由其自带 verifier 判为 `reward 1.0`；Harbor agent 类在 Harbor 0.26.0
下可加载。尚未在真实主机上的 Docker 中执行 `harbor run`。实际检查状态见 `VERIFICATION.json`。

## 目录

```text
src/core.js, python-tools.js, task.js, prompts.js   共享核心
python/worker.py                                     Python 工具 worker
src/plugin.js, host-model.js, cordis.patch.yml       DeepSeek Harness 适配层
bin/run-scitrace.mjs                                 独立 runner（OpenAI 兼容端点）
bin/harbor-task-to-scitrace.py                       Harbor 题包 → 任务目录
tasks/harbor-generic/                                通用工具 + 基准 prompt 模板
harbor/scitrace_harbor/                              Harbor 自定义 agent
harbor/run_catalaphile.sh, collect_runs.py           批量运行 / 收集脚本
examples/minimal/                                    最小手写任务
```

从 Git 分发，不发布到 npm。切勿提交 API 密钥、题目答案或运行产物。MIT 许可。
