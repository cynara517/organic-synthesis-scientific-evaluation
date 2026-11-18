#!/usr/bin/env bash
# Run a Harbor task once per model with the scientific-trace agent.
#
# Prereqs on the host:
#   docker (Docker Desktop running), uv, `uv tool install harbor` (Harbor >=0.26, Python >=3.12)
#
#   export SCI_BASE_URL=https://<gateway>/v1  SCI_API_KEY=...
#   export TASK_DIR=~/catalaphile/catalaphile-harbor      # unzipped Harbor package
#   bash harbor/run_catalaphile.sh claude-fable-5.1        # one model
#   bash harbor/run_catalaphile.sh                         # all eight, sequential
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"          # <plugin>/harbor
PLUGIN_DIR="$(dirname "$HERE")"                # <plugin>
TASK_DIR="${TASK_DIR:?set TASK_DIR to the unzipped Harbor task package}"
JOBS_DIR="${JOBS_DIR:-$PWD/jobs}"
QUESTION="${QUESTION:-$(basename "$TASK_DIR")}"
: "${SCI_BASE_URL:?set SCI_BASE_URL=https://<gateway>/v1}"
: "${SCI_API_KEY:?set SCI_API_KEY=...}"
GATEWAY_HOST="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.urlsplit(sys.argv[1]).hostname)' "$SCI_BASE_URL")"

# model_key (folder name used in the old bench_runs_*)  ->  wire model id sent to the gateway
declare -A WIRE=(
  [claude-fable-5.1]=claude-fable-5.1
  [claude-opus-5]=claude-opus-5
  [gpt-6-astra]=gpt-6-astra
  [hy4-preview]=hy4-preview
  [kimi-k3]=kimi-k3
  [glm-5.3]=glm-5.3
  [deepseek-v4-pro]=deepseek-v4-pro
  [qwen-3.8-max]=qwen-3.8-max
)
MODELS=("$@"); [ ${#MODELS[@]} -eq 0 ] && MODELS=("${!WIRE[@]}")

export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"
for key in "${MODELS[@]}"; do
  wire="${WIRE[$key]:-$key}"
  echo "=== $key ($wire) ==="
  harbor run -p "$TASK_DIR" \
    -a scitrace_harbor.agent:ScientificTraceAgent \
    -m "openai/$wire" \
    --ak plugin_dir="$PLUGIN_DIR" \
    --ak model_key="$key" --ak wire_model="$wire" --ak question="$QUESTION" \
    --ak max_iterations="${MAX_ITER:-250}" --ak run_timeout_sec="${RUN_TIMEOUT:-21000}" \
    --ae HARBOR_TASK_DIR="$TASK_DIR" \
    --ae SCI_BASE_URL="$SCI_BASE_URL" --ae SCI_API_KEY="$SCI_API_KEY" \
    --allow-agent-host "$GATEWAY_HOST" \
    --jobs-dir "$JOBS_DIR" --job-name "${QUESTION}__${key}" -k 1
done
echo "done. collect with: python3 $HERE/collect_runs.py $JOBS_DIR <out_dir>"
