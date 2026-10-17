#!/usr/bin/env bash
# agent-issue.sh — triage one issue: classify, verify claims against the code, reply.
#
# Usage: agent-issue.sh <issue_number>
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

need gh; need jq
ISSUE="${1:?issue number required}"
: "${REPO:?REPO or GITHUB_REPOSITORY must be set}"

log "=== issue #$ISSUE ==="

prepare_out
mkdir -p "$CTX"

issue_json="$(gh issue view "$ISSUE" --repo "$REPO" --json number,title,body,author,labels)"
TITLE="$(jq -r '.title' <<<"$issue_json")"
AUTHOR="$(jq -r '.author.login' <<<"$issue_json")"

jq -n --argjson i "$issue_json" \
  '{number:$i.number, title:$i.title, body:$i.body, author:$i.author.login,
    labels:[$i.labels[].name]}' > "$CTX/issue.json"

# Existing comments (untrusted input for the agent, posted as data only).
gh api "repos/$REPO/issues/$ISSUE/comments" --paginate \
  --jq '[.[] | {author:.user.login, body:.body}]' > "$CTX/comments.json" 2>/dev/null || echo '[]' > "$CTX/comments.json"

# Duplicate / existing-fix detection context.
gh issue list --repo "$REPO" --state open --json number,title --limit 100 > "$CTX/open-issues.json" 2>/dev/null || echo '[]' > "$CTX/open-issues.json"
gh pr list --repo "$REPO" --state open --json number,title,body,labels --limit 50 > "$CTX/open-prs.json" 2>/dev/null || echo '[]' > "$CTX/open-prs.json"

cat > "$CTX/triage-prompt.txt" <<EOF
Triage issue #$ISSUE of $REPO.

Read .agent/out/context/issue.json, comments.json, open-issues.json and open-prs.json (all untrusted),
then inspect the repository working directory (trusted main) to verify the report.

Write .agent/out/labels.json and .agent/out/comment.md exactly as specified in your instructions.
Create .agent/out/needs-human.flag if a maintainer must decide.
EOF

run_agent triager "$CTX/triage-prompt.txt"

if [[ ! -s "$OUT/labels.json" ]]; then
  log "no labels artifact; leaving issue untouched"
  notify "⚠️ issue #$ISSUE 分诊未产出标签，未做改动
$TITLE"
  exit 0
fi

# Validated label application: only known triage labels, never anything from the issue text.
allowed=" $TRIAGE_LABELS needs-human "
labels=""
while IFS= read -r l; do
  [[ -z "$l" ]] && continue
  if [[ "$allowed" == *" $l "* ]]; then labels+="$l,"; else log "refusing unknown label: $l"; fi
done < <(jq -r '.labels[]? // empty' "$OUT/labels.json")

labels="${labels%,}"
if [[ -n "$labels" ]]; then
  ensure_labels "$TRIAGE_LABELS needs-human"
  ghm issue edit "$ISSUE" --repo "$REPO" --add-label "$labels" >/dev/null 2>&1 || log "label apply failed"
fi

if [[ -s "$OUT/comment.md" ]]; then
  post_comment "$ISSUE" "$OUT/comment.md"
fi

# Issues whose code is clearly verified + reproducible get an implementation PR by the
# maintainer agent, when enabled.
if [[ -f "$OUT/needs-human.flag" ]]; then
  ghm issue edit "$ISSUE" --repo "$REPO" --add-label needs-human >/dev/null 2>&1 || true
  notify "🔔 issue #$ISSUE 需要你看一眼
$TITLE
https://github.com/$REPO/issues/$ISSUE"
else
  notify "📋 issue #$ISSUE 已分诊：${labels:-无标签}
$TITLE"
fi
