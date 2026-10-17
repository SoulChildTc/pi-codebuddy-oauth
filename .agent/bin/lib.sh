#!/usr/bin/env bash
# Shared helpers for maintainer-agent scripts.
# Requires: bash, gh, jq, curl. Runs on GitHub ubuntu runners; macOS ok for dry runs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/.agent/out"
CTX="$OUT/context"
MARKER='<!-- pi-codebuddy-agent:v1 -->'
REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
DRY_RUN="${DRY_RUN:-0}"

log()  { printf '[agent] %s\n' "$*" >&2; }
die()  { printf '[agent] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }

prepare_out() {
  rm -rf "$OUT"
  mkdir -p "$OUT" "$CTX"
}

# Snapshot the artifact state so a stale file from a previous phase can never be
# mistaken for the result of the current run.
mark_artifacts() {
  rm -f "$OUT/verdict.json" "$OUT/comment.md" "$OUT/labels.json" "$OUT/changelog.md" \
        "$OUT/needs-human.flag" "$OUT/review-retry.flag" "$OUT/.artifacts-ok"
}

require_artifact() { # path
  [[ -s "$1" ]] || die "agent did not produce: $1"
}

# Mutation wrapper: everything that changes GitHub state goes through this.
ghm() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN: gh $*"
    return 0
  fi
  gh "$@"
}

# Post a comment (issue or PR conversation) with the agent marker appended.
post_comment() { # item_number body_file
  local n="$1" body="$2" tmp
  tmp="$(mktemp)"
  cat "$body" > "$tmp"
  printf '\n\n%s\n' "$MARKER" >> "$tmp"
  ghm issue comment "$n" --body-file "$tmp"
  rm -f "$tmp"
}

notify() { # notify "text"
  local text="$1"
  if [[ "$DRY_RUN" == "1" ]]; then log "DRY_RUN notify: $text"; return 0; fi
  if [[ -z "${FEISHU_WEBHOOK:-}" ]]; then log "FEISHU_WEBHOOK not set; skipping notification"; return 0; fi
  curl -fsS -m 15 -X POST "$FEISHU_WEBHOOK" \
    -H 'Content-Type: application/json' \
    --data "$(jq -n --arg t "$text" '{msg_type:"text", content:{text:$t}}')" >/dev/null \
    || log "notification failed"
}

# Allowed triage labels (name -> color). Scripts refuse labels outside these sets.
TRIAGE_LABELS="bug question enhancement documentation duplicate invalid needs-info verified needs-human"

ensure_labels() { # space separated label names
  local existing l
  existing="$(gh label list --limit 100 --json name -q '.[].name' 2>/dev/null || true)"
  for l in $1; do
    if ! printf '%s\n' "$existing" | grep -qx "$l"; then
      case "$l" in
        bug)            ghm label create "$l" --color d73a4a --description "Something is not working" ;;
        question)       ghm label create "$l" --color d876e3 --description "Further information is requested" ;;
        enhancement)    ghm label create "$l" --color a2eeef --description "New feature or request" ;;
        documentation)  ghm label create "$l" --color 0075ca --description "Documentation" ;;
        duplicate)      ghm label create "$l" --color cfd3d7 --description "Duplicate" ;;
        invalid)        ghm label create "$l" --color e4e669 --description "Not actionable" ;;
        needs-info)     ghm label create "$l" --color fbca04 --description "Needs more information" ;;
        verified)       ghm label create "$l" --color 0e8a16 --description "Verified against the code" ;;
        needs-human)    ghm label create "$l" --color b60205 --description "Maintainer decision required" ;;
        review:approved)            ghm label create "$l" --color 0e8a16 --description "Agent review: approved" ;;
        review:changes-requested)   ghm label create "$l" --color d73a4a --description "Agent review: changes requested" ;;
        release:minor)              ghm label create "$l" --color 1d76db --description "Next release: minor bump" ;;
        release:none)               ghm label create "$l" --color c5def5 --description "No release needed" ;;
        tests-failed)   ghm label create "$l" --color e11d21 --description "CI tests failed on this PR" ;;
        *)              ghm label create "$l" --color ededed --description "" ;;
      esac
    fi
  done
}

# Run an opencode agent on a prompt file; artifacts are the success signal.
# Clears previous artifacts first so a failed run cannot inherit stale ones, then
# records a fingerprint of the artifacts the run actually produced.
run_agent() { # run_agent <agent> <prompt_file>
  local agent="$1" prompt="$2" rc=0
  mark_artifacts
  "$ROOT/.agent/bin/run-agent.sh" "$agent" "$prompt" || rc=$?
  if [[ "$rc" != "0" ]]; then
    log "agent '$agent' exited with code $rc (artifacts are still checked)"
  fi
  if [[ -f "$OUT/run.log" ]]; then
    tail -n 30 "$OUT/run.log" >&2 || true
  fi
  if [[ -s "$OUT/verdict.json" ]] || [[ -s "$OUT/comment.md" ]] || [[ -s "$OUT/labels.json" ]]; then
    : > "$OUT/.artifacts-ok"
  fi
  return 0
}
