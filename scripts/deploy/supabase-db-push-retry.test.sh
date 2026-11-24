#!/usr/bin/env bash
set -euo pipefail

helper=$(cd -- "$(dirname -- "$0")" && pwd)/supabase-db-push.sh
work=$(mktemp -d)
cd "$work"
trap 'rm -f cli log calls waited supabase/migrations/20260101000000_retry_probe.sql; rmdir supabase/migrations supabase; cd /; rmdir "$work"' EXIT
mkdir -p supabase/migrations
migration=20260101000000_retry_probe.sql
file=supabase/migrations/$migration

cat > cli <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == 'db push --linked --yes' ]]
printf 'push\n' >> calls
MOCK
chmod +x cli

sleep() {
  [[ "$*" == 5 ]]
  printf 'wait\n' >> waited
}
export -f sleep

check() {
  local label=$1 expected_status=$2 expected_message=$3 status=0 output
  : > calls
  : > waited
  output=$(bash "$helper" ./cli log 23 0 2>&1) || status=$?
  if [[ $expected_status == 0 ]]; then
    [[ $(<calls) == push && $(<waited) == wait ]]
  else
    [[ ! -s calls && ! -s waited ]]
  fi
  if [[ $status != "$expected_status" || $output != *"$expected_message"* ]]; then
    printf '%s failed (status %s)\n%s\n' "$label" "$status" "$output" >&2
    return 1
  fi
  printf 'PASS %s\n' "$label"
}

printf 'Applying migration %s...\r\nERROR: synthetic lock error (SQLSTATE 55P03)\r\n' "$migration" > log
cat > "$file" <<'SQL'
-- COMMIT; ALTER SYSTEM RESET work_mem;
BEGIN;
DO $$ BEGIN IF TRUE THEN NULL; END IF; END; $$;
SELECT 'CONCURRENTLY', "concurrently" FROM items;
END TRANSACTION;
SQL
check 'transactional migration with quoted tokens and CRLF CLI output' 0 'Retrying once'

printf 'BEGIN; SELECT 1; COMMIT; BEGIN; SELECT 2; END;\n' > "$file"
check 'two committed blocks' 23 'COMMIT or END'
printf 'BEGIN; SELECT 1; END WORK; SELECT 2;\n' > "$file"
check 'commit followed by another statement' 23 'COMMIT or END'

for sql in   'CREATE UNIQUE INDEX /* split */ CONCURRENTLY ix ON items (id);'   'DROP INDEX CONCURRENTLY ix;'   'REINDEX (VERBOSE) INDEX CONCURRENTLY ix;'   'ALTER TABLE items DETACH PARTITION old_items CONCURRENTLY;'   'REFRESH MATERIALIZED VIEW CONCURRENTLY item_counts;'   'VACUUM items;'   'CLUSTER items;'   'ALTER SYSTEM RESET work_mem;'   'REINDEX SCHEMA public;'   'REINDEX (VERBOSE) SYSTEM sample_db;'   'CREATE DATABASE sample_db;'   'DROP DATABASE sample_db;'   "CREATE TABLESPACE sample_space LOCATION '/tmp';"   "COMMIT PREPARED 'sample_transaction';" \
  'DROP TABLESPACE sample_space;'; do
  printf '%s\n' "$sql" > "$file"
  check "$sql" 23 'unsafe to replay'
done

printf "SELECT 'unterminated;\n" > "$file"
check 'unparseable migration' 23 'could not inspect the migration SQL'

rm -f "$file"
check 'missing migration' 23 'missing or is not a regular file'

printf 'Applying migration %s...\nApplying migration ../ambiguous.sql...\nERROR: synthetic lock error (SQLSTATE 40P01)\n' "$migration" > log
check 'malformed latest migration marker' 23 'could not identify the failing migration'
