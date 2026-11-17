# Organic Synthesis Scientific Evaluation

An evaluation suite for scientific reasoning in organic synthesis. The repository
holds four modules: an implemented scientific workflow plugin, evaluation prompts,
and two reserved modules.

| Module | Status | Purpose |
|---|---|---|
| [`scientific-trace/`](scientific-trace/) | **Implemented** | DeepSeek Harness plugin exposing `scientific_run`: a four-stage scientific workflow with evidence-linked traces. |
| [`dsr/`](dsr/) | Reserved | Deep synthesis reasoning. Not yet specified. |
| [`judge/`](judge/) | Prompts available | Separate model-based scoring of answer quality and execution-trace quality. |
| [`example/`](example/) | Reserved | Worked examples and task fixtures. Not yet specified. |

The `dsr/` and `example/` directories contain placeholder READMEs so the module
layout is fixed before their scope is decided. The `judge/` directory contains
evaluation prompts and usage documentation; an automated evaluator runner is not
yet implemented.

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

- Each module is self-contained and documents its scope in a README. Executable
  modules include their own `package.json` and tests; `judge/` currently contains
  prompts and documentation only.
- The plugin is the only module published to a package registry, and even it is
  distributed from Git today. The others are not packages yet.
- Nothing in this repository may contain API keys, task answers, or run artifacts.

## License

MIT. See [`LICENSE`](LICENSE).
