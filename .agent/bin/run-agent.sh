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
  local cmd=()
  [[ ${#proxy_env[@]} -gt 0 ]] && cmd+=("${proxy_env[@]}")
  cmd+=(opencode "${args[@]}" "$prompt")
  if command -v timeout >/dev/null 2>&1; then
    timeout "$AGENT_TIMEOUT" "${cmd[@]}"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$AGENT_TIMEOUT" "${cmd[@]}"
  else
    "${cmd[@]}"
  fi
}

echo "[run-agent] agent=$agent model=$model prompt_bytes=${#prompt}" >&2

# Retry policy: free models are rate limited transiently, so a short backoff and a
# second attempt is often enough. Each attempt is a fresh process (fresh context),
# which also covers providers that fail on the first request after a cold start.
attempt_run() { # label model
  local label="$1"
  local m="$2"
  local rc=0
  run_once "$m" >>"$log_file" 2>&1 || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    echo "[run-agent] $label run finished" >&2
    return 0
  fi
  echo "[run-agent] $label run failed (rc=$rc)" >&2
  return 1
}

attempt=1
max_attempts="${AGENT_ATTEMPTS:-2}"
models=("$model")
[[ "$FALLBACK_MODEL" != "$model" ]] && models+=("$FALLBACK_MODEL")

for m in "${models[@]}"; do
  while [[ "$attempt" -le "$max_attempts" ]]; do
    if attempt_run "$m (attempt $attempt)" "$m"; then
      exit 0
    fi
    attempt=$((attempt + 1))
    if [[ "$attempt" -le "$max_attempts" ]]; then
      sleep_for=$((15 * attempt))
      echo "[run-agent] model $m failed; retrying in ${sleep_for}s" >&2
      sleep "$sleep_for"
    fi
  done
  attempt=1
  echo "[run-agent] switching to next model" >&2
done

echo "[run-agent] all models failed" >&2
exit 1
