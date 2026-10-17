#!/usr/bin/env bash
# agent-test.sh — run the repository test suite for a PR head SHA.
#
# SECURITY: this is the ONLY script that executes untrusted PR code. It runs in a
# workflow with contents:read and no secrets. The evidence it produces (a successful
# job for a given head SHA) is what the merge gate consumes.
#
# Usage: agent-test.sh <pr_number>
set -euo pipefail

PR="${1:?pr number required}"

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

echo "[agent-test] fetching PR #$PR head" >&2
git fetch --no-tags --depth=1 origin "pull/$PR/head:refs/agent/test-$PR"
SHA="$(git rev-parse "refs/agent/test-$PR")"
echo "[agent-test] head sha: $SHA" >&2

git checkout --force "refs/agent/test-$PR"

if [[ ! -f package.json ]]; then
  echo "[agent-test] no package.json at PR head; nothing to test" >&2
  exit 0
fi

echo "[agent-test] npm ci (lifecycle scripts disabled)" >&2
npm ci --ignore-scripts --no-audit --no-fund

echo "[agent-test] typecheck" >&2
npm run typecheck

echo "[agent-test] tests" >&2
npm test
