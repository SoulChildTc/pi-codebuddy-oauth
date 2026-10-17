#!/usr/bin/env bash
# Run one opencode agent headlessly. Usage: run-agent.sh <agent> <prompt-file> [model]
# Success is determined by artifacts produced (checked by callers), not just exit code.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/.agent/out"
AGENT_TIMEOUT="${AGENT_TIMEOUT:-1500}" # seconds

agent="${1:?agent name required}"
prompt_file="${2:?prompt file required}"
# Model selection: DEFAULT_MODEL > per-call argument > built-in default.
# CI can point this at any available provider (e.g. an OpenCode API key or another
# OpenAI-compatible provider) without touching the agent definitions.
model="${3:-${DEFAULT_MODEL:-opencode/deepseek-v4.1-flash-free}}"
FALLBACK_MODEL="${FALLBACK_MODEL:-opencode/glm-5.3-flash-free}"

command -v opencode >/dev/null 2>&1 || { echo "[run-agent] opencode CLI not found" >&2; exit 1; }

prompt="$(cat "$prompt_file")"
mkdir -p "$OUT"
log_file="$OUT/run.log"
: > "$log_file"

# Optional egress proxy for local runs (CI runners have direct egress and no proxy).
# Set AGENT_PROXY=http://127.0.0.1:7890 in your shell to use it locally.
proxy_env=()
if [[ -n "${AGENT_PROXY:-}" ]]; then
  proxy_env=(env "http_proxy=$AGENT_PROXY" "https_proxy=$AGENT_PROXY" "all_proxy=$AGENT_PROXY" \
                 "HTTP_PROXY=$AGENT_PROXY" "HTTPS_PROXY=$AGENT_PROXY" "ALL_PROXY=$AGENT_PROXY")
  echo "[run-agent] using proxy $AGENT_PROXY" >&2
fi

# Model is always passed explicitly: agent frontmatter model fields are not
# guaranteed to win over the ambient session/config model.
run_once() { # $1 = model
  local m="$1"
  local args=(run --standalone --auto --agent "$agent" --model "$m")
  local cmd=("${proxy_env[@]}" opencode "${args[@]}" "$prompt")
  if command -v timeout >/dev/null 2>&1; then
    timeout "$AGENT_TIMEOUT" "${cmd[@]}"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$AGENT_TIMEOUT" "${cmd[@]}"
  else
    "${cmd[@]}"
  fi
}

echo "[run-agent] agent=$agent model=$model prompt_bytes=${#prompt}" >&2

if run_once "$model" >>"$log_file" 2>&1; then
  echo "[run-agent] primary run finished" >&2
else
  rc=$?
  echo "[run-agent] primary run failed (rc=$rc); retrying with fallback model $FALLBACK_MODEL" >&2
  [[ "$FALLBACK_MODEL" == "$model" ]] && exit 1
  run_once "$FALLBACK_MODEL" >>"$log_file" 2>&1 || {
    echo "[run-agent] fallback run failed too" >&2
    exit 1
  }
fi
