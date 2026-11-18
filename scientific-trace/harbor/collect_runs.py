#!/usr/bin/env python3
"""Reorganise Harbor job output into the legacy bench_runs layout + score CSV.

    python3 collect_runs.py <jobs_dir> <out_dir>

Produces  <out_dir>/bench_runs_1/<model_key>/catalaphile/{scientific_trace.json,
trajectory.json, answer.txt, run_meta.json, agent_status.json, run.log,
results/answer.json, results/geometries/*.xyz, reward.json}
and <out_dir>/score_summary.csv with reward (0-1) and answer_score_100.
"""
import csv
import json
import shutil
import sys
from pathlib import Path

jobs_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
rows = []
for results in sorted(jobs_dir.glob("*/*/results.json")):
    trial = results.parent
    res = json.loads(results.read_text())
    cfg = json.loads((trial / "config.json").read_text())
    kw = (cfg.get("agent") or {}).get("kwargs") or {}
    model_key = kw.get("model_key") or (cfg.get("agent") or {}).get("model_name", "unknown").split("/")[-1]
    question = kw.get("question", "catalaphile")
    dst = out_dir / "bench_runs_1" / model_key / question
    (dst / "results").mkdir(parents=True, exist_ok=True)
    agent_dir = trial / "agent"
    for name in ("scientific_trace.json", "trajectory.json", "answer.txt", "run_meta.json",
                 "agent_status.json", "run.log", "science-events.jsonl", "runner.stdout.log"):
        if (agent_dir / name).exists():
            shutil.copy2(agent_dir / name, dst / name)
    # artifacts: /app/answer.json and /app/geometries (mirrored under artifacts/app/)
    art = trial / "artifacts"
    for cand in (art / "app" / "answer.json", art / "answer.json"):
        if cand.exists():
            shutil.copy2(cand, dst / "results" / "answer.json")
            break
    for cand in (art / "app" / "geometries", art / "geometries"):
        if cand.is_dir():
            shutil.copytree(cand, dst / "results" / "geometries", dirs_exist_ok=True)
            break
    reward = None
    vr = trial / "verifier" / "reward.json"
    if vr.exists():
        reward = json.loads(vr.read_text()).get("reward")
        shutil.copy2(vr, dst / "reward.json")
    for extra in ("verifier/test-stdout.txt", "verifier/report.json", "verifier/checker.log"):
        if (trial / extra).exists():
            shutil.copy2(trial / extra, dst / Path(extra).name)
    meta = {}
    if (dst / "run_meta.json").exists():
        meta = json.loads((dst / "run_meta.json").read_text())
    rows.append({
        "model": model_key, "question": question, "run": 1,
        "reward": reward, "answer_score_100": None if reward is None else round(float(reward) * 100, 2),
        "outcome": meta.get("outcome"), "steps_used": meta.get("steps_used"),
        "wall_sec": meta.get("wall_sec"), "exception": (res.get("exception_info") or {}).get("exception_type"),
        "trial_dir": str(trial),
    })
out_dir.mkdir(parents=True, exist_ok=True)
with (out_dir / "score_summary.csv").open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ["model"])
    w.writeheader(); w.writerows(rows)
for r in rows:
    print(f"{r['model']:<20} reward={r['reward']}  score100={r['answer_score_100']}  outcome={r['outcome']} steps={r['steps_used']}")
print(f"\nwritten: {out_dir/'score_summary.csv'}")
