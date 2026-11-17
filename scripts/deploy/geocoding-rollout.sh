#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ENV_FILE_PATH="${ENV_FILE:-}"
EVIDENCE_ROOT="${EVIDENCE_DIR:-${REPO_ROOT}/docs/ops/evidence}"
TIMESTAMP="${EVIDENCE_SUFFIX:-$(date +%Y%m%d_%H%M%S)}"
EVIDENCE_DIR="${EVIDENCE_ROOT}/${TIMESTAMP}"

if [[ -n "${ENV_FILE_PATH}" && -f "${ENV_FILE_PATH}" ]]; then
  echo "[geocoding-rollout] Loading environment from ${ENV_FILE_PATH}"
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE_PATH}"
  set +a
elif [[ -z "${ENV_FILE_PATH}" && -f "${REPO_ROOT}/config/env/.env.cloud" ]]; then
  ENV_FILE_PATH="${REPO_ROOT}/config/env/.env.cloud"
  echo "[geocoding-rollout] Loading environment from ${ENV_FILE_PATH}"
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE_PATH}"
  set +a
else
  echo "[geocoding-rollout] No ENV file provided/found; using current process environment."
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[geocoding-rollout] DATABASE_URL is required" >&2
  exit 1
fi

mkdir -p "${EVIDENCE_DIR}"

echo "[geocoding-rollout] Running pgTAP suite against ${DATABASE_URL}"
ENV_FILE="${ENV_FILE_PATH:-}" node "${REPO_ROOT}/scripts/tests/run-pgtap-cloud.js" | tee "${EVIDENCE_DIR}/pgtap.log"

echo "[geocoding-rollout] Running integration tests in cloud mode"
(
  cd "${REPO_ROOT}"
  CLOUD_MODE=1 ENV_FILE="${ENV_FILE_PATH:-}" npm run test:integration | tee "${EVIDENCE_DIR}/integration.log"
)

echo "[geocoding-rollout] Previewing migrations"
npx --yes supabase@2 db push --dry-run --db-url "${DATABASE_URL}" | tee "${EVIDENCE_DIR}/db-push-dry-run.log"

echo "[geocoding-rollout] Applying migrations"
npx --yes supabase@2 db push --yes --db-url "${DATABASE_URL}" | tee "${EVIDENCE_DIR}/db-push.log"

echo "[geocoding-rollout] Capturing supabase db lint output (wrapper with exceptions)"
ENV_FILE="${ENV_FILE_PATH:-}" node "${REPO_ROOT}/scripts/tooling/run-db-lint.js" | tee "${EVIDENCE_DIR}/geocoding_db_lint.txt"

echo "[geocoding-rollout] Exporting geocoding policy snapshot"
psql "${DATABASE_URL}" <<'SQL' | tee "${EVIDENCE_DIR}/geocoding_policy_snapshot.sql"
--
-- Geocoding policy ladder snapshot
--
SELECT
  category,
  scope_type,
  scope_id,
  version,
  effective_from,
  effective_until,
  change_reason,
  value
FROM settings_versions
WHERE category = 'geocoding_policy'
ORDER BY scope_type, scope_id, version DESC;

--
-- Active settings cache (post-approval)
--
SELECT
  scope_type,
  scope_id,
  cached_value
FROM settings
WHERE category = 'geocoding_policy'
ORDER BY scope_type, scope_id;

--
-- Manual review backlog
--
SELECT
  organization_id,
  queue_assignment,
  status,
  COUNT(*) AS task_count
FROM manual_review_tasks
WHERE task_type IN ('geocoding', 'geocoding_auto_learn')
GROUP BY 1,2,3
ORDER BY task_count DESC;
SQL

echo "[geocoding-rollout] Evidence stored in ${EVIDENCE_DIR}"
