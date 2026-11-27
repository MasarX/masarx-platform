#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || ! $1 =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ || ! $2 =~ ^[a-f0-9]{40}$ ]]; then
  printf '%s\n' 'Usage: require-ci-gate.sh <repo> <sha> <gh command...>' >&2
  exit 1
fi
repo=$1
sha=$2
shift 2
gh_cli=("$@")

# Pull-request CI may skip jobs and can use a workflow changed by the PR.
if ! suites="$("${gh_cli[@]}" api --paginate --slurp \
  "repos/$repo/actions/workflows/public-ci.yml/runs?head_sha=$sha&per_page=100" \
  | jq -c --arg sha "$sha" '[.[].workflow_runs[]
    | select(.head_sha == $sha and (.check_suite_id | type == "number"))
    | select((.event == "merge_group" and (.head_branch // "" | startswith("gh-readonly-queue/main/")))
      or (.event == "push" and .head_branch == "main"))
    | .check_suite_id]')" ||
   ! checks="$("${gh_cli[@]}" api --paginate --slurp \
  "repos/$repo/commits/$sha/check-runs?check_name=ci-gate&filter=all&per_page=100")"; then
  printf '%s\n' 'Could not read CI check evidence for the release commit.' >&2
  exit 1
fi

if ! jq -e --arg sha "$sha" --argjson suites "$suites" '
  [.[].check_runs[]
    | select(.name == "ci-gate" and .head_sha == $sha and .app.slug == "github-actions")
    | select(.check_suite.id as $suite | $suites | index($suite))]
  | max_by(.id)
  | .status == "completed" and .conclusion == "success"
' <<< "$checks" > /dev/null; then
  printf '%s\n' 'Release requires a successful ci-gate from the latest qualifying public CI evidence on the exact SHA.' >&2
  exit 1
fi
