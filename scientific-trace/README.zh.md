# Scientific Trace

Organic Synthesis Scientific Evaluation 的 `scientific-trace` 模块：
一个 DeepSeek Harness 插件，从 Git 分发，未发布到 npm。

> **首次使用前必须配置。** `scientific_run` 需要两个目录。配置之前每次调用都会
> 失败并提示缺少哪个键。见下方「安装与配置」，只需改一处。

插件为 DeepSeek Harness 注册 `scientific_run` 工具，调用后运行四阶段流程：
经验规划 → 计划与工具选择 → Python 执行 → 检查点与路由。
它把原 `traced_agent.py` 的状态转换移植为独立 JavaScript 核心，保留四类
科学 trace；Python 科学工具继续在持久 worker 中执行，不依赖 LangGraph。
默认 Harness agent 负责调用这个科学求解器，不会被全局替换。

## 使用条件

- Node.js ≥24.9。测试套件实际验证的 Harness 版本为 `0.2.2-rc.1`；清单同时允许
  `0.2.1-rc.2` 及后续 0.2.x，但在这些版本上尚未测试。
- Python ≥3.10，以及任务工具实际需要的 NumPy、SciPy 等依赖。
- 在 Harness 中配置可用模型；插件读取调用方选择的 provider/model。
- 显式配置可信任务根目录 `taskRoot`、日志根目录 `logRoot` 和 Python 路径。

## 安装

在 Harness 的 **插件 → 添加插件** 对话框里粘贴安装说明：

```text
git+https://github.com/<你的用户名>/organic-synthesis-scientific-evaluation.git#<40位commit>&path:/scientific-trace
```

或在终端：

```sh
dsh plugin --profile <你的profile> add "git+https://github.com/<你的用户名>/organic-synthesis-scientific-evaluation.git#<40位commit>&path:/scientific-trace"
```

请固定到完整 commit。分支名或 tag 也能用，但结果不可复现。

## 安装与配置（必做）

在 profile 的 `cordis.patch.yml` 中新增一条覆盖项。这是开关插件同一个文件，
请新增一条，不要改插件自带的 patch。

```yaml
- id: scientific-agent
  config:
    taskRoot: /绝对路径/可信任务目录
    logRoot: /绝对路径/日志目录
    python: python3
```

| 键 | 必填 | 含义 |
|---|---|---|
| `taskRoot` | 是 | 存放各任务文件夹的目录。任务名在其中解析，越界路径会被拒绝。 |
| `logRoot` | 是 | 每次运行在此写入 `scientific_trace.json`、`trajectory.json` 和 `science-events.jsonl`。必须可写。 |
| `python` | 否 | Python 解释器，默认 `python3`。 |
| `maxIterations` | 否 | 规划迭代次数，默认 15。 |
| `parseRetries` | 否 | 模型输出解析重试，默认 3。 |
| `requestTimeoutMs` | 否 | 单次模型请求，默认 300000。 |
| `toolTimeoutMs` | 否 | 单次 Python 工具调用，默认 120000。 |
| `runTimeoutMs` | 否 | 整次运行，默认 1800000。 |
| `provider`、`model`、`reasoningEffort`、`maxTokens` | 否 | 覆盖调用方的模型路由；省略则继承。 |

### 立即试跑

包内已带一个可用的示例任务 `examples/minimal`。把该目录复制进 `taskRoot`，
文件夹命名为 `minimal`，然后调用：

```json
{"task": "minimal"}
```

预期结果：工具计算 3、6、9 的均值与样本标准差，并在本次运行的日志目录中
写入 `results/summary.json`。这一次调用同时验证了 Python worker、模型路由
和两个配置路径。

## 任务格式

```text
my-task/
  instruction.md
  tool_definitions.json
  tools.py                      # 或被 tool_definitions.json 引用的模块
  data/                         # 可选输入数据
  prompt_templates.json         # 可选提示词模板
  reference_cases.json          # 可选，[{"id": "case-id", ...}]
  scientific-agent.json         # 可选，domain/type 与 requiredArtifacts
```

`instruction.md` 和 `tool_definitions.json` 必需；Python 模块必须在任务目录内。
未提供 `prompt_templates.json` 时使用通用科学提示词，未提供 `reference_cases.json`
时保持无参考案例。`scientific-agent.json` 的 `requiredArtifacts` 可声明最终
必须存在且能解析的 JSON。

## 记录与恢复

每次运行生成独立 UUID，并输出科学 trace、ATIF、追加式事件日志、原子检查点
和最终答案。解析失败的模型响应会保留并计数，不会变成空工具调用。
数值正确性由独立 verifier 检查；`answer_correct` 不由 agent 自行填写。
原代码的 evaluator 只做检查点与路由，此版本保留这个定义。

传入 `run_id` 可恢复未完成运行。恢复时保留总步数预算，完成过的工具不重放；
Python 内存变量会消失，规划器会收到明确说明，需从数据和已有产物重建状态。
若工具在中途被终止且副作用未知，则拒绝自动恢复。

工具是可信 Python 代码，任务路径检查不等于执行沙箱。对不可信任务应在
Harbor 容器等外部边界中运行。宿主工具策略看到的是外层 `scientific_run`，
内部 Python 调用由插件记录；模型请求使用宿主 LLM 服务。worker 不接收模型
凭据环境变量。取消时等待 worker 退出；对派生进程的清理由外部容器兜底。

## 验证与分发状态

`npm test` 检查工作流、重试、恢复、路径和 worker；
`test/host-integration.mjs` 在真实 Harness 组件中验证插件生命周期；
BAT20 回放会重新执行工具和计算，但模型响应来自历史记录；
新模型实跑是独立项目，不能用回放代替。

具体结果见 `VERIFICATION.json`。原始题目、历史答案和凭据不会进入安装包。
本插件通过 Git 仓库分发，不走 npm；安装时请固定到具体 commit，
见上文「安装」。`npm run prepublishOnly` 仍用于将来的 registry 发布，
发布检查未完成前会失败。请勿提交 API 密钥、题目答案、历史运行记录或本地凭据文件。

完整任务格式、限制和配置见 [English README](README.md)。
