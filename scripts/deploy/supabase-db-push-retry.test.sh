#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
helper="$root/scripts/deploy/supabase-db-push.sh"
work=$(mktemp -d)
cd "$work"
trap 'rm -f cli push.sh log db-push.log calls waited supabase/migrations/20260101000000_retry_probe.sql; rmdir supabase/migrations supabase; cd /; rmdir "$work"' EXIT
mkdir -p supabase/migrations
migration=20260101000000_retry_probe.sql
file=supabase/migrations/$migration

# Isolate the workflow's first push and retry pipeline from subsequent deploy steps.
cat > push.sh <<'PUSH'
set -euo pipefail
cli=$1
deploy_temp=$2

bash() {
  [[ "$1" == scripts/deploy/supabase-db-push.sh ]] || return 1
  shift
  command bash "$DEPLOY_RETRY_HELPER" "$@"
}
PUSH
awk '
  /^          export NO_COLOR=1$/ { capture = 1 }
  capture && /^          apply_status=0$/ { exit }
  capture { print }
' "$root/.github/workflows/deploy.yml" >> push.sh

cat > cli <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == 'db push --linked --yes' && "$NO_COLOR" == 1 ]]
if [[ ! -s calls ]]; then
  printf 'push\n' >> calls
  cat log >&2
  exit "$FIRST_STATUS"
fi
printf 'push\n' >> calls
exit "$SECOND_STATUS"
MOCK
chmod +x cli

sleep() {
  [[ "$*" == 5 ]]
  printf 'wait\n' >> waited
}
export -f sleep

check() {
  local label=$1 expected_status=$2 expected_calls=$3 expected_message=$4
  local first_status=${5:-23} second_status=${6:-0} log_dir=${7:-$work} status=0 output
  : > calls
  : > waited
  output=$(FIRST_STATUS=$first_status SECOND_STATUS=$second_status DEPLOY_RETRY_HELPER=$helper \
    bash push.sh ./cli "$log_dir" 2>&1) || status=$?
  if [[ $status != "$expected_status" || $(wc -l < calls) -ne $expected_calls ||
        $(wc -l < waited) -ne $((expected_calls - 1)) || $output != *"$expected_message"* ]]; then
    printf '%s failed (status %s, calls %s)\n%s\n' "$label" "$status" "$(wc -l < calls)" "$output" >&2
    return 1
  fi
  printf 'PASS %s\n' "$label"
}

printf 'Finished supabase db push.\n' > log
check 'first push succeeds' 0 1 'Finished supabase db push.' 0

printf 'Applying migration %s...\r\nERROR: synthetic lock error (SQLSTATE 55P03)\r\n' "$migration" > log
cat > "$file" <<'SQL'
-- COMMIT; ALTER SYSTEM RESET work_mem;
BEGIN;
DO $$ BEGIN IF TRUE THEN NULL; END IF; END; $$;
SELECT 'CONCURRENTLY', "concurrently" FROM items;
END TRANSACTION;
SQL
check 'transactional migration with quoted tokens and CRLF CLI output' 0 2 'Retrying once'
check 'second push preserves its failure status' 23 2 'Retrying once' 23 23
check 'log capture failure stops retries' 1 1 'db-push.log' 23 0 "$work/missing"
printf 'Applying migration %s...\nERROR: synthetic lock error (SQLSTATE 40P01)\n' "$migration" > log
check 'deadlock retries once' 0 2 'SQLSTATE 40P01 while applying'

printf 'ERROR: synthetic error (SQLSTATE 23505)\nSELECT %s;\n' "'quoted SQLSTATE 40P01)'" > log
check 'lock code in printed SQL is ignored' 23 1 'SQLSTATE 23505'
printf 'Applying migration %s...\nERROR: synthetic lock error (SQLSTATE 40P01)\n' "$migration" > log

printf 'BEGIN; SELECT 1; COMMIT; BEGIN; SELECT 2; END;\n' > "$file"
check 'two committed blocks' 23 1 'COMMIT or END'
printf 'BEGIN; SELECT 1; END WORK; SELECT 2;\n' > "$file"
check 'commit followed by another statement' 23 1 'COMMIT or END'

for sql in   'CREATE UNIQUE INDEX /* split */ CONCURRENTLY ix ON items (id);'   'DROP INDEX CONCURRENTLY ix;'   'REINDEX (VERBOSE) INDEX CONCURRENTLY ix;'   'ALTER TABLE items DETACH PARTITION old_items CONCURRENTLY;'   'REFRESH MATERIALIZED VIEW CONCURRENTLY item_counts;'   'VACUUM items;'   'CLUSTER items;'   'ALTER SYSTEM RESET work_mem;'   'REINDEX SCHEMA public;'   'REINDEX (VERBOSE) SYSTEM sample_db;'   'CREATE DATABASE sample_db;'   'DROP DATABASE sample_db;'   "CREATE TABLESPACE sample_space LOCATION '/tmp';"   "COMMIT PREPARED 'sample_transaction';" \
  'DROP TABLESPACE sample_space;'; do
  printf '%s\n' "$sql" > "$file"
  check "$sql" 23 1 'unsafe to replay'
done

printf "SELECT 'unterminated;\n" > "$file"
check 'unparseable migration' 23 1 'could not inspect the migration SQL'

rm -f "$file"
check 'missing migration' 23 1 'missing or is not a regular file'

printf 'Applying migration %s...\nApplying migration ../ambiguous.sql...\nERROR: synthetic lock error (SQLSTATE 40P01)\n' "$migration" > log
check 'malformed latest migration marker' 23 1 'could not identify the failing migration'
