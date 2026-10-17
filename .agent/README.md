# Maintainer Agent

Automated maintenance for this repository: triage issues, review pull requests,
merge what passes the gates, and publish releases. Runs entirely in GitHub Actions.
## Why it is safe to let it merge

The agent never gets a merge button. It produces **artifacts**; a trusted shell
script reads those artifacts and decides whether to act.

| Layer | Runs where | Permission | What it can do |
|---|---|---|---|
| Sandbox (`agent-test.yml`) | PR code | `contents: read`, no secrets | `npm ci`, typecheck, tests |
| Decision (`agent-pr.yml`) | trusted `main` | `contents: write` | comment, label, merge |
| Publish (`agent-release.yml`) | trusted `main` | OIDC (`id-token: write`) | bump, publish npm, tag |

The workflow files are read from `main`, so a pull request cannot modify the code
that decides whether to merge it.

### Gates before merging (all must pass)

1. A successful `agent-test` run for the **exact head SHA** (fail closed: no
   evidence means no merge).
2. Reviewer `verdict.json` is schema-valid and `approve: true`.
3. No prompt injection detected.
4. For sensitive paths — `.github/**`, `.agent/**`, `.opencode/**`,
   `opencode.jsonc`, `package*.json`, `.npmrc`, `src/auth*.ts`, `src/config*.ts`,
   `src/token*.ts`, `src/oauth*.ts` — a **second, independent** security review
   must also approve, with fresh context.
5. Deterministic scan must not flag command execution or unknown outbound hosts.

If anything is uncertain, the agent does not merge and notifies instead.

## Layout

```
.agent/bin/
  lib.sh            shared helpers, label allowlist, mutation wrapper (DRY_RUN aware)
  run-agent.sh      headless opencode runner (model configurable, fallback model)
  agent-test.sh     sandboxed test run (only script that executes PR code)
  agent-issue.sh    triage one issue
  agent-pr.sh       review + gates + merge
  agent-comment.sh  reply to follow-up comments
  agent-release.sh  version bump + CHANGELOG + npm publish + tag
  selftest.sh       offline checks (run this before pushing)
.opencode/agents/
  triager.md  reviewer.md  security-reviewer.md  answerer.md  releaser.md
.github/workflows/
  agent-test.yml  agent-issue.yml  agent-pr.yml  agent-comment.yml
  agent-release.yml  agent-backlog.yml
```

## Operating it

| Task | How |
|---|---|
| Process the existing backlog | Actions → **agent-backlog** → Run workflow (`dry_run` first if unsure) |
| Re-review one PR | Actions → **agent-pr** → Run workflow → PR number |
| Re-triage one issue | Actions → **agent-issue** → Run workflow → issue number |
| Local offline checks | `./.agent/bin/selftest.sh` |
| Local dry run of a full PR pass | `DRY_RUN=1 REPO=<owner/repo> ./.agent/bin/agent-pr.sh <pr>` |

`DRY_RUN=1` prints every mutation instead of performing it.

## Configuration

| Name | Type | Default | Meaning |
|---|---|---|---|
| `FEISHU_WEBHOOK` | secret | _(empty)_ | Notification webhook; skipped when unset |
| `OPENCODE_API_KEY` | secret | _(empty)_ | Provider credential, when the model needs one |
| `AGENT_MODEL` | variable | `opencode/deepseek-v4.1-flash-free` | Model for all agents |
| `AGENT_FALLBACK_MODEL` | variable | `opencode/glm-5.3-flash-free` | Retry model when the first fails |

Models are passed with `--model` explicitly. If both the primary and the
fallback model fail, the agent produces no artifacts and nothing is merged.

## npm publishing

`agent-release.yml` publishes with **Trusted Publishing (OIDC)**; no npm token is
stored. Configure it once at
`https://www.npmjs.com/package/pi-codebuddy-oauth/access`:

- Publisher: **GitHub Actions**
- Organization/user: `SoulChildTc`
- Repository: `pi-codebuddy-oauth`
- Workflow filename: `agent-release.yml`
- Environment: _(leave empty)_

Version policy: `release:minor` on a PR bumps the minor version, otherwise patch.
`release:none` skips the release. Major bumps are never automatic.

## Known limits

- **Model availability is the bottleneck.** Free models are rate limited; if both
  the primary and fallback model fail, the run ends without artifacts and the PR
  or issue is left untouched (no merge, no comment). Point `AGENT_MODEL` at a
  stable paid model if that happens often.
- The reviewer reads a snapshot of the PR tree plus a diff; it does not build the
  PR. Test execution happens only in `agent-test`, on the runner, isolated.
- Issue triage can classify and explain, but does not write fix PRs yet.
- **First rollout:** `workflow_run` triggers only fire for workflows that already
  exist on the default branch. So `agent-pr.yml` starts reacting to `agent-test`
  completions only after this change is merged to `main`. Until then, start PR
  reviews manually with the `agent-pr` workflow (`workflow_dispatch`).
- `agent-pr` and `agent-release` both write to `main`; if a protected branch rule
  requires human review, merges and release pushes will fail. Either allow
  `github-actions[bot]` on `main`, or keep the rules and accept that the agent
  reports "merge failed" instead of merging.

