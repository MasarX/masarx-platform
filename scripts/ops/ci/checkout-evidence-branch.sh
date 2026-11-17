#!/usr/bin/env bash
set -euo pipefail

REMOTE="${REMOTE:-origin}"
BASE_BRANCH="${BASE_BRANCH:-dev}"
EVIDENCE_BRANCH="${EVIDENCE_BRANCH:-ops/evidence}"

echo "[checkout-evidence-branch] remote=${REMOTE} base=${BASE_BRANCH} evidence=${EVIDENCE_BRANCH}"

# Ensure we can resolve the base branch (actions/checkout may have fetched only one ref).
git fetch --no-tags "${REMOTE}" "${BASE_BRANCH}" >/dev/null 2>&1 || true

if git ls-remote --exit-code --heads "${REMOTE}" "${EVIDENCE_BRANCH}" >/dev/null 2>&1; then
  git fetch --no-tags "${REMOTE}" "${EVIDENCE_BRANCH}" >/dev/null 2>&1
  git checkout -B "${EVIDENCE_BRANCH}" "${REMOTE}/${EVIDENCE_BRANCH}"
  echo "[checkout-evidence-branch] checked out existing branch"
else
  git checkout -B "${EVIDENCE_BRANCH}" "${REMOTE}/${BASE_BRANCH}"
  git push "${REMOTE}" "HEAD:refs/heads/${EVIDENCE_BRANCH}"
  echo "[checkout-evidence-branch] created branch from ${REMOTE}/${BASE_BRANCH}"
fi
