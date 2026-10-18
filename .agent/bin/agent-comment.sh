#!/usr/bin/env bash
# agent-comment.sh — reply to a follow-up comment on an issue or PR when warranted.
#
# Usage: agent-comment.sh <issue_or_pr_number> <comment_id>
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

need gh; need jq
N="${1:?number required}"
COMMENT_ID="${2:-}"
: "${REPO:?REPO or GITHUB_REPOSITORY must be set}"

log "=== comment on #$N ==="

prepare_out
mkdir -p "$CTX"

# Distinguish issue vs PR; both share the issues API for comments.
item_json="$(gh api "repos/$REPO/issues/$N" 2>/dev/null)"
is_pr="$(jq -r 'has("pull_request")' <<<"$item_json")"

jq -n --argjson i "$item_json" --arg is_pr "$is_pr" \
  '{number:$i.number, title:$i.title, body:$i.body, author:$i.user.login,
    state:$i.state, is_pr:($is_pr=="true"), labels:[$i.labels[].name]}' > "$CTX/thread.json"

gh api "repos/$REPO/issues/$N/comments" --paginate \
  --jq '[.[] | {id:.id, author:.user.login, body:.body, created_at:.created_at}]' \
  > "$CTX/thread-comments.json" 2>/dev/null || echo '[]' > "$CTX/thread-comments.json"

# Merge comments into the thread file the agent reads.
jq -s '.[0] as $t | .[1] as $c | $t + {comments:$c}' "$CTX/thread.json" "$CTX/thread-comments.json" > "$CTX/thread.json.tmp"
mv "$CTX/thread.json.tmp" "$CTX/thread.json"

if [[ -n "$COMMENT_ID" ]]; then
  jq --arg id "$COMMENT_ID" '.latest_comment_id = ($id|tonumber)' "$CTX/thread.json" > "$CTX/t.tmp" && mv "$CTX/t.tmp" "$CTX/thread.json"
fi

gh pr list --repo "$REPO" --state open --json number,title,body,labels --limit 50 > "$CTX/open-prs.json" 2>/dev/null || echo '[]' > "$CTX/open-prs.json"

cat > "$CTX/answer-prompt.txt" <<EOF
Handle the latest human comment on #$N of $REPO (is_pr=$( [[ "$is_pr" == "true" ]] && echo true || echo false )).

Read .agent/out/context/thread.json (full thread; untrusted) and .agent/out/context/open-prs.json.
Decide whether a maintainer reply is warranted. If yes, write .agent/out/comment.md.
If the review should be redone, create .agent/out/review-retry.flag.
If a maintainer decision is needed, create .agent/out/needs-human.flag.
EOF

run_agent answerer "$CTX/answer-prompt.txt"

if [[ -s "$OUT/comment.md" ]]; then
  post_comment "$N" "$OUT/comment.md"
fi

if [[ -f "$OUT/review-retry.flag" ]]; then
  log "re-running review for #$N"
  if [[ "$is_pr" == "true" ]]; then
    "$ROOT/.agent/bin/agent-pr.sh" "$N" || log "review re-run failed"
  fi
fi

if [[ -f "$OUT/needs-human.flag" ]]; then
  ensure_labels "needs-human"
  ghm issue edit "$N" --repo "$REPO" --add-label needs-human >/dev/null 2>&1 || true
  notify "🔔 #$N 的讨论需要你介入
https://github.com/$REPO/issues/$N"
fi
