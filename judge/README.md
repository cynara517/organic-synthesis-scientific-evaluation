# Judge

Model-based evaluation prompts for completed benchmark task runs. Answer quality
and execution-trace quality are scored separately, each out of 100 points.

## Prompts

| Prompt | Scoring target | Scoring rules |
|---|---|---|
| [`answer_scoring_prompt.md`](answer_scoring_prompt.md) | Final answer and supporting result files | The task run's `rubrics.md` is the only authoritative answer rubric. |
| [`trace_scoring_prompt.md`](trace_scoring_prompt.md) | Execution process recorded in `scientific_trace.json` | The fixed trace rubric and score caps defined in the prompt. |

The trace rubric covers task understanding and planning (15 points), tool use and
execution coverage (20), evidence chain and reproducibility (20), error handling
and recovery (15), efficiency and budget control (10), and integrity and
instruction compliance (20). Answer quality alone does not determine trace quality.

## Inputs

Each evaluation operates in one concrete task-run directory, typically containing:

```text
<task-run>/
├── rubrics.md
├── answer.txt
├── scientific_trace.json
├── results/
└── run_meta.json
```

- Answer evaluation reads `rubrics.md`, `answer.txt`, and relevant result files.
- Trace evaluation reads `scientific_trace.json`; it uses the answer and results
  only to check consistency, not to rescore the scientific answer.
- Both prompts inspect run metadata when available. Alternative metadata filenames,
  missing-file handling, deductions, and caps are specified in the prompts.

## Usage

1. Select the answer or trace prompt and provide its contents as the evaluator's
   instructions.
2. Give the evaluator file-reading and report-writing tools, with its working
   directory set to the task-run directory.
3. Run answer and trace evaluations separately. The prompts specify report names
   for Gemini and Grok:

| Evaluation | Gemini report | Grok report |
|---|---|---|
| Answer | `score_answer_gemini.md` | `score_answer_grok.md` |
| Trace | `score_trace_gemini.md` | `score_trace_grok.md` |

Reports are written in the task-run directory. Each Markdown report includes the
total score, files checked, a scoring breakdown with evidence paths and reasons,
applicable checks and caps, a consistency check, and a final JSON block.

Keep answer and trace scores separate. Review the cited evidence and applied
rules when auditing a score. Evaluation rubrics are used after task execution;
hidden scoring materials must not be exposed to the model performing the task.

## Status

This directory contains prompts and documentation. It does not yet include an
automated evaluator runner, model API integration, or a packaged entry point.
Keep task answers, run artifacts, generated reports, and API keys out of this
repository.
