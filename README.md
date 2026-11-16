# Organic Synthesis Scientific Evaluation

An evaluation suite for scientific reasoning in organic synthesis. The repository
holds four modules; only the first is implemented today.

| Module | Status | Purpose |
|---|---|---|
| [`scientific-trace/`](scientific-trace/) | **Implemented** | DeepSeek Harness plugin exposing `scientific_run`: a four-stage scientific workflow with evidence-linked traces. |
| [`dsr/`](dsr/) | Reserved | Deep synthesis reasoning. Not yet specified. |
| [`judge/`](judge/) | Reserved | Scoring and adjudication of evaluation runs. Not yet specified. |
| [`example/`](example/) | Reserved | Worked examples and task fixtures. Not yet specified. |

The three reserved directories contain a placeholder README stating what is known
and nothing more. They exist so the module layout is fixed before their scope is
decided.

## Install the plugin

The plugin lives in a subdirectory, so the install spec names that directory with
pnpm's `path:` parameter. Pin the full 40-character commit:

```text
git+https://github.com/<owner>/organic-synthesis-scientific-evaluation.git#<commit>&path:/scientific-trace
```

From a shell:

```sh
dsh plugin --profile <your-profile> add "git+https://github.com/<owner>/organic-synthesis-scientific-evaluation.git#<commit>&path:/scientific-trace"
```

Configuration is required before the tool runs. See
[`scientific-trace/README.md`](scientific-trace/README.md).

## Repository conventions

- Each module is self-contained: its own `package.json`, README, and tests.
- The plugin is the only module published to a package registry, and even it is
  distributed from Git today. The others are not packages yet.
- Nothing in this repository may contain API keys, task answers, or run artifacts.

## License

MIT. See [`LICENSE`](LICENSE).
