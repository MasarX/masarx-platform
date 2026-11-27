#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
helper="$root/scripts/deploy/supabase-db-push.sh"
work=$(mktemp -d)
cd "$work"
trap 'rm -f cli push.sh log db-push.log calls waited other.sql supabase/migrations/20260101000000_retry_probe.sql; rmdir supabase/migrations supabase; cd /; rmdir "$work"' EXIT
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

sleep() {
  [[ "$*" == 5 ]]
  printf 'wait\n' >> waited
}
export -f sleep
PUSH
awk '
  /^          export NO_COLOR=1$/ { capture = 1 }
  capture && /^          apply_status=0$/ { complete = 1; exit }
  capture { count++; print }
  END { if (!complete || count != 3) exit 1 }
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

check() {
  local label=$1 expected_status=$2 expected_calls=$3 expected_message=$4
  local first_status=${5:-23} second_status=${6:-0} log_dir=${7:-$work} status=0 output warnings
  : > calls
  : > waited
  output=$(env -i PATH="$PATH" FIRST_STATUS="$first_status" SECOND_STATUS="$second_status" \
    DEPLOY_RETRY_HELPER="$helper" bash --noprofile --norc push.sh ./cli "$log_dir" 2>&1) || status=$?
  warnings=$(awk '/^::warning::Supabase db push failed with / { count++ } END { print count + 0 }' <<< "$output")
  if [[ $status != "$expected_status" || $(wc -l < calls) -ne $expected_calls ||
        $(wc -l < waited) -ne $((expected_calls - 1)) || $warnings -ne $((expected_calls - 1)) ||
        $output != *"$expected_message"* ]]; then
    printf '%s failed (status %s, calls %s)\n%s\n' "$label" "$status" "$(wc -l < calls)" "$output" >&2
    return 1
  fi
  printf 'PASS %s\n' "$label"
}

printf 'Finished supabase db push.\n' > log
check 'first push succeeds' 0 1 'Finished supabase db push.' 0

printf 'Applying migration %s...\r\nERROR: synthetic lock error (SQLSTATE 55P03)\r\nAt statement: 2\r\nSELECT 1;\r\n' "$migration" > log
cat > "$file" <<'SQL'
-- COMMIT; ALTER SYSTEM RESET work_mem;
BEGIN;
DO $$ BEGIN IF TRUE THEN NULL; END IF; END; $$;
SELECT 'CONCURRENTLY', "concurrently" FROM items;
END TRANSACTION;
SQL
check 'transactional migration with quoted tokens and CRLF CLI output' 0 2 "SQLSTATE 55P03 while applying $migration"
check 'second push preserves its failure status' 23 2 'Retrying once' 23 23
check 'log capture failure stops retries' 1 1 'db-push.log' 23 0 "$work/missing"
printf 'Applying migration %s...\nERROR: synthetic lock error (SQLSTATE 40P01)\nSynthetic deadlock detail.\nAt statement: 2\nSELECT 1;\n' "$migration" > log
check 'deadlock retries once' 0 2 'SQLSTATE 40P01 while applying'
check 'second deadlock preserves its failure status' 23 2 'SQLSTATE 40P01 while applying' 23 23

printf 'BEGIN; SELECT 1; COMMIT;\n' > "$file"
printf 'Applying migration %s...\nERROR: synthetic lock error (SQLSTATE 40P01)\nAt statement: 3\nINSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)\n' "$migration" > log
check 'history insert after COMMIT stops retries' 23 1 'migration history write'
printf 'Applying migration %s...\nERROR: synthetic lock error (SQLSTATE 40P01)\nAt statement: 3\nSELECT 1;\n' "$migration" > log
check 'out-of-range statement index stops retries' 23 1 'could not match the failing statement to the migration'
printf 'Applying migration %s...\nERROR: synthetic lock error (SQLSTATE 40P01)\n' "$migration" > log
check 'missing statement evidence stops retries' 23 1 'could not identify the failing statement'
printf 'Applying migration %s...\nERROR: synthetic lock error (SQLSTATE 40P01)\nAt statement: 1\n' "$migration" > log
check 'missing failing SQL stops retries' 23 1 'could not identify the failing statement'
printf 'Applying migration %s...\nERROR: synthetic lock error (SQLSTATE 40P01)\nAt statement: 1\nSELECT 1;\nAt statement: 2\nSELECT 2;\n' "$migration" > log
check 'ambiguous statement evidence stops retries' 23 1 'could not identify the failing statement'

printf 'ERROR: synthetic error (SQLSTATE 23505)\nSELECT %s;\n' "'quoted SQLSTATE 40P01)'" > log
check 'lock code in printed SQL is ignored' 23 1 'SQLSTATE 23505'
printf 'Applying migration %s...\nERROR: synthetic lock error (SQLSTATE 40P01)\nAt statement: 0\nSELECT 1;\n' "$migration" > log

printf 'BEGIN; SELECT 1; COMMIT; BEGIN; SELECT 2; END;\n' > "$file"
check 'two committed blocks' 23 1 'COMMIT or END'
printf 'BEGIN; SELECT 1; END WORK; SELECT 2;\n' > "$file"
check 'commit followed by another statement' 23 1 'COMMIT or END'

for sql in \
  'CREATE UNIQUE INDEX /* split */ CONCURRENTLY ix ON items (id);' \
  'DROP INDEX CONCURRENTLY ix;' \
  'REINDEX (VERBOSE) INDEX CONCURRENTLY ix;' \
  'ALTER TABLE items DETACH PARTITION old_items CONCURRENTLY;' \
  'REFRESH MATERIALIZED VIEW CONCURRENTLY item_counts;' \
  'VACUUM items;' \
  'CLUSTER items;' \
  'ALTER SYSTEM RESET work_mem;' \
  'REINDEX SCHEMA public;' \
  'REINDEX (VERBOSE) SYSTEM sample_db;' \
  'REINDEX (VERBOSE TABLE items;' \
  'CREATE DATABASE sample_db;' \
  'DROP DATABASE sample_db;' \
  "CREATE TABLESPACE sample_space LOCATION '/tmp';" \
  'DROP TABLESPACE sample_space;' \
  "PREPARE TRANSACTION 'sample_transaction';" \
  "COMMIT PREPARED 'sample_transaction';" \
  "ROLLBACK PREPARED 'sample_transaction';" \
  "SELECT dblink_exec('sample_connection', 'SELECT 1');" \
  "SELECT pg_background_launch('SELECT 1');" \
  'SELECT extensions.http_get(NULL);' \
  'SELECT extensions.http(NULL);' \
  'SELECT net.http_post(NULL);' \
  "SELECT cron.schedule('sample', '* * * * *', 'SELECT 1');" \
  "COPY items TO PROGRAM 'true';" \
  "COPY items TO '/tmp/sample.csv';" \
  "SELECT lo_export(0, '/tmp/sample.bin');" \
  'SELECT pg_file_write(NULL, NULL, false);' \
  'SELECT pg_terminate_backend(0);' \
  'SELECT pg_cancel_backend(0);' \
  'SELECT pg_reload_conf();' \
  'SELECT pg_advisory_lock(0);' \
  'SELECT pg_advisory_unlock_all();' \
  'SELECT pg_switch_wal();' \
  "SELECT setval('sample_sequence', 1);" \
  "SELECT nextval('sample_sequence');" \
  'ALTER SUBSCRIPTION sample_subscription DISABLE;' \
  'SET standard_conforming_strings = off;' \
  'RESET ALL;' \
  'EXECUTE sample_statement;' \
  'DO LANGUAGE plpythonu $$ pass $$;' \
  'DO $$ BEGIN EXECUTE current_setting('"'sample.command'"'); END $$;' \
  'DO $$ BEGIN EXECUTE '"'SELECT pg_reload_conf()'"'; END $$;'; do
  printf '%s\n' "$sql" > "$file"
  check "$sql" 23 1 'unsafe to replay'
done

printf "SELECT 'unterminated;\n" > "$file"
check 'unparseable migration' 23 1 'could not inspect the migration SQL'
printf '\\i fixture.sql\n' > "$file"
check 'psql meta-command stops retries' 23 1 'could not inspect the migration SQL'
printf '\377\n' > "$file"
check 'invalid UTF-8 stops retries' 23 1 'could not inspect the migration file'

rm -f "$file"
check 'missing migration' 23 1 'missing or is not a regular file'
printf 'SELECT 1;\n' > other.sql
ln -s ../../other.sql "$file"
check 'symlinked migration stops retries' 23 1 'missing or is not a regular file'

printf 'ERROR: synthetic lock error (SQLSTATE 40P01)\nAt statement: 0\nSELECT 1;\n' > log
check 'missing migration marker stops retries' 23 1 'could not identify the failing migration'

printf 'Applying migration %s...\nApplying migration ../ambiguous.sql...\nERROR: synthetic lock error (SQLSTATE 40P01)\n' "$migration" > log
check 'malformed latest migration marker' 23 1 'could not identify the failing migration'
