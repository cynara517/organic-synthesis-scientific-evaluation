import json
from pathlib import Path
from statistics import mean, stdev


def summarize(values):
    if len(values) < 2:
        raise ValueError("At least two measurements are required")
    result = {"n": len(values), "mean": mean(values), "sample_stdev": stdev(values), "units": "arbitrary units"}
    Path("results").mkdir(exist_ok=True)
    Path("results/summary.json").write_text(json.dumps(result, indent=2) + "\n")
    return json.loads(Path("results/summary.json").read_text())
