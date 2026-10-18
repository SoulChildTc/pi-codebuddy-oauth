#!/usr/bin/env bash
# agent-pr.sh — review one pull request and merge it when every deterministic gate passes.
#
# Usage: agent-pr.sh <pr_number>
#
# Trust model: this script runs from the trusted main branch with write permission.
# It NEVER executes code from the PR (that happens only in agent-test.yml). It reads
# PR content as data, runs the reviewer agent(s) as data producers, validates their
# artifacts, then applies labels/comments/merge itself.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

need gh; need jq
PR="${1:?pr number required}"
: "${REPO:?REPO or GITHUB_REPOSITORY must be set}"

SENSITIVE_RE='^(\.github/|\.agent/|opencode\.jsonc$|\.npmrc$|package\.json$|package-lock\.json$|\.opencode/|src/(auth|auth-fetch|config|token|oauth)[^/]*\.ts$)'

log "=== PR #$PR ==="

prepare_out
mkdir -p "$CTX/tree"

# ---------------------------------------------------------------- context gathering
pr_json="$(gh pr view "$PR" --repo "$REPO" \
  --json number,title,body,author,isCrossRepository,headRefOid,baseRefOid,headRefName,baseRefName,files,labels,mergeable,mergeStateStatus,reviewDecision)"

HEAD_SHA="$(jq -r '.headRefOid' <<<"$pr_json")"
IS_FORK="$(jq -r '.isCrossRepository' <<<"$pr_json")"
TITLE="$(jq -r '.title' <<<"$pr_json")"
AUTHOR="$(jq -r '.author.login' <<<"$pr_json")"
MERGEABLE="$(jq -r '.mergeable' <<<"$pr_json")"

# Fetch the PR head and base branch into private refs (no checkout, no execution).
# Unshallow/deepen first: a shallow repository makes merge-base fail, and a missing
# merge base would silently defeat the scanner.
if [[ -f "$(git rev-parse --git-dir)/shallow" ]]; then
  log "repository is shallow; unshallowing to compute the merge base"
  git fetch --unshallow origin 2>/dev/null || git fetch --deepen=500 origin 2>/dev/null || true
fi
git fetch --no-tags origin "+refs/pull/$PR/head:refs/agent/pr-$PR" >/dev/null 2>&1 || {
  log "failed to fetch PR head"; exit 1; }
BASE_REF="$(jq -r '.baseRefName' <<<"$pr_json")"
git fetch --no-tags origin "+refs/heads/$BASE_REF:refs/agent/base-$PR" >/dev/null 2>&1 || true

# Changed files come from the API (authoritative subset of what the PR touches).
changed_files="$(jq -r '.files[].path' <<<"$pr_json")"

# Diff must cover exactly the files this PR touches, against the merge base.
# Computing it as "root..head" would include the whole repository and silently
# defeat the scanner, so an unavailable merge base fails closed instead.
base_commit=""
if base_commit="$(git merge-base "refs/agent/base-$PR" "refs/agent/pr-$PR" 2>/dev/null)"; then
  log "merge-base: $base_commit"
else
  log "ERROR: no merge base between PR head and $BASE_REF; refusing to review"
  notify "⚠️ PR #${PR}：无法计算与 $BASE_REF 的共同祖先，已跳过自动审查（不合并）"
  exit 0
fi

: > "$CTX/diff.patch"
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  git diff --no-color "$base_commit" "refs/agent/pr-$PR" -- "$f" >> "$CTX/diff.patch" 2>/dev/null || true
done <<< "$changed_files"

diff_lines="$(wc -l < "$CTX/diff.patch" 2>/dev/null || echo 0)"
log "diff lines: $diff_lines (across $(printf '%s\n' "$changed_files" | grep -c . || true) changed file(s))"
if [[ "$diff_lines" -lt 1 ]]; then
  log "ERROR: empty diff although the PR reports changes; refusing to review"
  notify "⚠️ PR #${PR}：diff 为空，已跳过自动审查（不合并）"
  exit 0
fi

# Extract the PR tree as read-only reference material for the agent.
rm -rf "$CTX/tree"; mkdir -p "$CTX/tree"
if ! git archive "refs/agent/pr-$PR" 2>/dev/null | tar -x -C "$CTX/tree" 2>/dev/null; then
  log "git archive failed; extracting via worktree-free checkout"
  git --work-tree="$CTX/tree" checkout "refs/agent/pr-$PR" -- . 2>/dev/null || \
    log "WARNING: could not materialize PR tree; reviewer will rely on the diff only"
fi
tree_count="$(find "$CTX/tree" -type f 2>/dev/null | wc -l | tr -d ' ')"
log "PR tree files: $tree_count"

# ------------------------------------------------------------- deterministic scan
# Delegated to scan-diff.sh so the tested scanner and the enforcing scanner are the
# same code.
"$ROOT/.agent/bin/scan-diff.sh" "$CTX/diff.patch" > "$CTX/scan.json"

sensitive_count="$(jq '.sensitive_paths | length' "$CTX/scan.json")"
max_sev="$(jq -r '[.flags[].severity] | if length==0 then "none" elif index("high") then "high" elif index("medium") then "medium" else "low" end' "$CTX/scan.json")"
log "scan: ${sensitive_count} sensitive path(s), max severity ${max_sev}"

# ------------------------------------------------------------ review-failure state
reset_review_labels() {
  ghm pr edit "$PR" --repo "$REPO" --remove-label tests-failed >/dev/null 2>&1 || true
}

fail_pr() { # reason comment_body [security]
  local reason="$1" comment="$2" security="${3:-}" tmp
  reset_review_labels
  ensure_labels "review:changes-requested tests-failed"
  tmp="$(mktemp)"; printf '%s' "$comment" > "$tmp"
  post_comment "$PR" "$tmp"; rm -f "$tmp"
  ghm pr edit "$PR" --repo "$REPO" --add-label review:changes-requested --add-label tests-failed >/dev/null 2>&1 || true
  notify "⚠️ PR #$PR (by $AUTHOR) 未合并：$reason
$TITLE"
  if [[ "$security" == "security" ]]; then
    notify "🚨 安全警示 PR #${PR}：$reason"
  fi
  log "PR #$PR blocked: $reason"
  exit 0
}

# ---------------------------------------------------------------- CI evidence gate
# Evidence = the newest successful agent-test run for this exact head SHA.
# A 404 means the workflow does not exist on the default branch yet (first rollout);
# in that case merge is blocked rather than silently allowed - fail closed.
test_runs_json="$(gh api "repos/$REPO/actions/workflows/agent-test.yml/runs?head_sha=$HEAD_SHA&per_page=5" 2>/dev/null || echo '')"
if [[ -z "$test_runs_json" ]]; then
  log "cannot query agent-test runs (workflow may not exist yet); refusing to merge"
  exit 0
fi
test_conclusion="$(jq -r '(.workflow_runs // [])[0] | .conclusion // "none"' <<<"$test_runs_json" 2>/dev/null || echo "none")"

if [[ "$test_conclusion" != "success" ]]; then
  log "no successful test run for $HEAD_SHA (got: $test_conclusion)"
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log "DRY_RUN: continuing despite missing CI evidence"
  else
    exit 0   # the test workflow (re)runs separately; this run simply waits
  fi
fi

if [[ "$MERGEABLE" == "CONFLICTING" ]]; then
  fail_pr "merge conflict" "## 需要 rebase

此 PR 与 \`main\` 存在冲突，无法自动合并。请 rebase 到最新 \`main\` 后 push，我会自动重新审查。"
fi

# ------------------------------------------------------------------- review pass 1
jq -n --argjson pr "$pr_json" \
      --argjson open_prs "$(gh pr list --repo "$REPO" --state open --json number,title,labels --limit 50 2>/dev/null || echo '[]')" \
      '{number:$pr.number, title:$pr.title, body:$pr.body, author:$pr.author.login,
        is_fork:$pr.isCrossRepository, base_sha:$pr.baseRefOid, head_sha:$pr.headRefOid,
        changed_files:[$pr.files[]|{filename:.path, additions:.additions, deletions:.deletions}],
        linked_issues:[], open_prs:$open_prs}' > "$CTX/pr.json"

cat > "$CTX/review-prompt.txt" <<EOF
Review pull request #$PR of $REPO.

Read, in this order:
- .agent/out/context/pr.json  (metadata, untrusted)
- .agent/out/context/scan.json (deterministic scan results)
- .agent/out/context/diff.patch (the change under review)
- .agent/out/context/tree/     (PR head snapshot — use it to read the change in context)
- the repository working directory (trusted main) for comparison and documented behavior

Write .agent/out/verdict.json and .agent/out/comment.md exactly as specified in your instructions.
EOF

run_agent reviewer "$CTX/review-prompt.txt"
if [[ ! -s "$OUT/verdict.json" ]] || [[ ! -s "$OUT/comment.md" ]]; then
  # Fail closed AND make it visible: with free models, rate limits make this the
  # most likely failure mode, and silence would look like "nothing to do".
  ensure_labels "agent-error"
  ghm pr edit "$PR" --repo "$REPO" --add-label agent-error >/dev/null 2>&1 || true
  notify "⚠️ PR #$PR 自动审查未能完成（模型不可用/限流），本轮未做任何改动
$TITLE
作者：$AUTHOR
可重试：Actions → agent-pr → Run workflow → PR 号 $PR"
  log "reviewer produced no verdict (likely model failure); alerted"
  exit 0
fi

verdict="$(cat "$OUT/verdict.json")"
jq -e 'type=="object" and has("approve") and has("risk_level") and has("sensitive_files_touched")
       and has("injection_detected") and has("escalate_to_human") and has("findings")' \
  <<<"$verdict" >/dev/null || fail_pr "malformed verdict" "## 自动审查失败

审查代理未能产出合法结论（schema 校验失败），需要人工确认。"

approve="$(jq -r '.approve' <<<"$verdict")"
injection="$(jq -r '.injection_detected' <<<"$verdict")"
escalate="$(jq -r '.escalate_to_human' <<<"$verdict")"
release_kind="$(jq -r '.release_kind // "patch"' <<<"$verdict")"

# Prompt-injection and pipeline-integrity attempts are never auto-mergeable.
if [[ "$injection" == "true" ]]; then
  ensure_labels "needs-human"
  ghm pr edit "$PR" --repo "$REPO" --add-label needs-human >/dev/null 2>&1 || true
  post_comment "$PR" "$OUT/comment.md"
  notify "🚨 PR #$PR 检测到 prompt injection 尝试，已停止自动化处理
$TITLE"
  log "PR #$PR: injection detected, stopping"
  exit 0
fi

# ------------------------------------------------------- review pass 2 (security)
if [[ "$sensitive_count" -gt 0 || "$max_sev" == "high" || "$max_sev" == "medium" ]]; then
  log "security pass required (sensitive=$sensitive_count max_sev=$max_sev)"
  cat > "$CTX/security-prompt.txt" <<EOF
Independent security review of pull request #$PR of $REPO.

This PR touches privileged paths and/or triggered static-scan flags. Read:
- .agent/out/context/scan.json  (what triggered this pass)
- .agent/out/context/diff.patch
- .agent/out/context/tree/
- .agent/out/context/pr.json (untrusted metadata)

Write .agent/out/verdict.json and .agent/out/comment.md exactly as specified in your instructions.
EOF
  run_agent security-reviewer "$CTX/security-prompt.txt"
  if [[ -s "$OUT/verdict.json" ]]; then
    sec_verdict="$(cat "$OUT/verdict.json")"
    sec_approve="$(jq -r '.approve // false' <<<"$sec_verdict" 2>/dev/null || echo false)"
    [[ -s "$OUT/comment.md" ]] && cp "$OUT/comment.md" "$OUT/security-comment.md"
  else
    sec_approve="false"
  fi
  if [[ "$sec_approve" != "true" ]]; then
    ensure_labels "needs-human"
    ghm pr edit "$PR" --repo "$REPO" --add-label needs-human >/dev/null 2>&1 || true
    [[ -s "${OUT}/security-comment.md" ]] && post_comment "$PR" "$OUT/security-comment.md"
    # Distinguish "the model says no" from "the model never ran": the second is an
    # infrastructure failure, not a security finding, and should say so.
    if [[ -s "$OUT/verdict.json" ]] && jq -e 'has("approve")' <<<"$sec_verdict" >/dev/null 2>&1; then
      notify "🚨 PR #$PR 未通过安全二次审查，需人工确认
$TITLE
作者：$AUTHOR"
      log "PR #$PR: security pass rejected"
    else
      ensure_labels "agent-error"
      ghm pr edit "$PR" --repo "$REPO" --add-label agent-error >/dev/null 2>&1 || true
      notify "⚠️ PR #$PR 安全二次审查未能完成（模型不可用/限流），本轮未合并
$TITLE
可重试：Actions → agent-pr → Run workflow → PR 号 $PR"
      log "PR #$PR: security pass produced no verdict; alerted"
    fi
    exit 0
  fi
  [[ -s "${OUT}/security-comment.md" ]] && post_comment "$PR" "$OUT/security-comment.md"
fi

# --------------------------------------------------------------------- merge gate
post_comment "$PR" "$OUT/comment.md"

if [[ "$approve" != "true" ]]; then
  ensure_labels "review:changes-requested"
  ghm pr edit "$PR" --repo "$REPO" --add-label review:changes-requested >/dev/null 2>&1 || true
  if [[ "$escalate" == "true" ]]; then
    ensure_labels "needs-human"
    ghm pr edit "$PR" --repo "$REPO" --add-label needs-human >/dev/null 2>&1 || true
    notify "🔔 PR #$PR 需你拍板：$(jq -r '.escalation_reason // "见 PR 评论"' <<<"$verdict")
$TITLE"
  fi
  log "PR #$PR: changes requested"
  exit 0
fi

# Approved: record the release intent label, then merge.
case "$release_kind" in
  minor) rel_label="release:minor" ;;
  none)  rel_label="release:none" ;;
  *)     rel_label="" ;;
esac
[[ -n "$rel_label" ]] && ghm pr edit "$PR" --repo "$REPO" --add-label "$rel_label" >/dev/null 2>&1 || true
ensure_labels "review:approved"
ghm pr edit "$PR" --repo "$REPO" --add-label review:approved --remove-label review:changes-requested >/dev/null 2>&1 || true

if [[ "$IS_FORK" == "true" ]] && [[ "${ALLOW_FORK_MERGE:-1}" != "1" ]]; then
  log "fork PR approved but fork merging disabled"; exit 0
fi

ghm pr merge "$PR" --repo "$REPO" --squash --delete-branch=false \
  --subject "$TITLE (#$PR)" 2>&1 | tail -3 || {
    log "merge failed"; notify "⚠️ PR #$PR 审查通过但合并失败（可能分支保护/权限限制）"; exit 0; }

notify "✅ 已合并 PR #${PR}（${AUTHOR}）
$TITLE
→ 触发自动发布"
log "PR #$PR merged"
