#!/usr/bin/env bash
# scan-diff.sh — deterministic static scan of a unified diff.
#
# Usage: scan-diff.sh <diff_file>  →  prints a JSON object:
#   { "sensitive_paths": [...], "flags": [ {severity,code,detail} ] }
#
# This is the single source of truth for the scanner. Both agent-pr.sh and the
# offline attack-sample tests call it, so the tested logic cannot drift from the
# logic that actually gates merges.
set -uo pipefail

DIFF="${1:?diff file required}"

# Paths whose modification requires a second, independent security review:
# CI/pipeline files, dependency manifests, and the authentication code itself.
SENSITIVE_RE='^(\.github/|\.agent/|opencode\.jsonc$|\.npmrc$|package\.json$|package-lock\.json$|\.opencode/|src/(auth|auth-fetch|config|token|oauth)[^/]*\.ts$)'

sensitive_paths_json='[]'
flags_json='[]'

add_flag() { # severity code detail
  flags_json="$(jq -c --arg s "$1" --arg c "$2" --arg d "$3" \
    '. + [{severity:$s, code:$c, detail:$d}]' <<<"$flags_json")"
}

added_lines="$(grep -E '^\+' "$DIFF" | grep -v '^+++' || true)"

# --- command execution / dynamic code evaluation -------------------------------
if printf '%s\n' "$added_lines" | grep -qE '\b(child_process|execSync|spawnSync|execFileSync|eval\(|new Function\()'; then
  add_flag high command-execution "diff adds process execution or dynamic code evaluation"
fi

# --- outbound hosts against a known-good allowlist -----------------------------
# Only complete hostnames with a dot are considered: diff headers such as
# "+++ b/x" and prose fragments produce single-token noise otherwise.
while IFS= read -r h; do
  [[ -z "$h" ]] && continue
  [[ "$h" == *.* ]] || continue
  case "$h" in
    *tencent.com|*codebuddy.cn|*codebuddy.ai|*github.com|*githubusercontent.com|*npmjs.com|*npmjs.org) ;;
    *) add_flag medium new-host "diff references outbound host: $h" ;;
  esac
done <<< "$(printf '%s\n' "$added_lines" | grep -oE 'https?://[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z]{2,}' | sed -E 's#https?://##' | sort -u || true)"

# --- obfuscation ---------------------------------------------------------------
if printf '%s\n' "$added_lines" | grep -qE 'atob\(|Buffer\.from\([^)]*(base64|hex)'; then
  add_flag medium obfuscation "diff decodes base64/hex payloads"
fi

# Zero-width and bidi control characters. Done with a byte-level scan because
# grep pattern handling of these code points is inconsistent across platforms.
if printf '%s\n' "$added_lines" | LC_ALL=C grep -qE $'\xe2\x80\x8b|\xe2\x80\xae|\xe2\x81\xa6|\xe2\x81\xa9'; then
  add_flag high unicode-trick "diff contains zero-width or bidi control characters"
fi

# --- sensitive paths -----------------------------------------------------------
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  [[ "$f" =~ $SENSITIVE_RE ]] && sensitive_paths_json="$(jq -c --arg p "$f" '. + [$p] | unique' <<<"$sensitive_paths_json")"
done <<< "$(grep -E '^\+\+\+ b/' "$DIFF" | sed -E 's#^\+\+\+ b/##' || true)"

jq -n --argjson s "$sensitive_paths_json" --argjson f "$flags_json" \
  '{sensitive_paths:$s, flags:$f}'
