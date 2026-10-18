#!/usr/bin/env bash
# selftest.sh — offline checks for the maintainer agent's deterministic parts.
# No network, no GitHub mutations. Run: ./.agent/bin/selftest.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

echo "== script syntax =="
for f in .agent/bin/*.sh .github/workflows/*.yml; do
  case "$f" in
    *.sh) bash -n "$f" 2>/dev/null && ok "bash -n $f" || bad "bash -n $f" ;;
    *.yml) ruby -ryaml -e "YAML.load_file('$f')" 2>/dev/null && ok "yaml $f" || bad "yaml $f" ;;
  esac
done

echo "== agent definitions =="
for a in triager reviewer security-reviewer answerer releaser; do
  f=".opencode/agents/$a.md"
  check "$a exists" "[[ -f '$f' ]]"
  check "$a has default-deny" "grep -q 'action: \"\\*\"' '$f' && grep -A2 'action: \"\\*\"' '$f' | grep -q 'effect: deny'"
  check "$a cannot use shell" "! grep -qE 'action: shell' '$f'"
  check "$a cannot use execute/Code Mode" "grep -q 'default-deny' '$f'"
  check "$a writes only to .agent/out" "grep -q 'resource: \".agent/out/\\*\"' '$f'"
done

echo "== permission model regression (Code Mode must stay unreachable) =="
# A wildcard action that is ALLOWED would re-open every tool, including Code Mode.
check "no agent allows a wildcard action" \
  "! grep -A1 'action: \"\\*\"' .opencode/agents/*.md | grep -B1 'effect: allow' | grep -q 'action: \"\\*\"'"

echo "== diff scanner =="
scanner_test() { # name expect_flag diff_text
  local name="$1" expect="$2" text="$3"
  local tmp; tmp="$(mktemp)"; printf '%s\n' "$text" > "$tmp"
  local hit="no"
  local added; added="$(grep -E '^\+' "$tmp" | grep -v '^+++' || true)"
  printf '%s\n' "$added" | grep -qE '\b(child_process|execSync|spawnSync|eval\(|new Function\()' && hit="yes"
  rm -f "$tmp"
  check "$name" "[[ '$hit' == '$expect' ]]"
}

scanner_test "flags child_process" "yes" '+ import { execSync } from "child_process";'
scanner_test "flags eval" "yes" '+ eval(payload);'
scanner_test "ignores normal code" "no" '+ const x = compute(a, b);'

echo "== schema validation of a good/bad verdict =="
valid='{"approve":true,"risk_level":"low","release_kind":"patch","sensitive_files_touched":false,"injection_detected":false,"escalate_to_human":false,"escalation_reason":"","issues_verified":[],"findings":[],"summary":"ok"}'
invalid='{"approve":"yes"}'
v() { jq -e 'type=="object" and has("approve") and has("risk_level") and has("sensitive_files_touched") and has("injection_detected") and has("escalate_to_human") and has("findings")' <<<"$1" >/dev/null 2>&1; }
check "accepts valid verdict" "v '$valid'"
check "rejects incomplete verdict" "! v '$invalid'"

echo "== label allowlist =="
source .agent/bin/lib.sh
allowed=" $TRIAGE_LABELS needs-human "
check "allows known label" "[[ '$allowed' == *' bug '* ]]"
check "rejects unknown label" "[[ '$allowed' != *' approved-by-me '* ]]"

echo "== shell hygiene =="
# A variable immediately followed by a multi-byte character (e.g. Chinese
# punctuation) is parsed as part of the name and fails under set -u.
check "no unbraced var before non-ASCII" \
  "! grep -qE '\\\$[A-Za-z_]+[^ -~]' .agent/bin/*.sh"
# An array expansion inside a quoted element ("${arr[@]}" cmd) injects an empty
# string when the array is empty, which makes the shell execute ''.
check "proxy array not embedded as a quoted element" \
  "! grep -q '\"\\\${proxy_env\\[@\\]}\" opencode' .agent/bin/run-agent.sh"

echo
printf 'passed %d, failed %d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
