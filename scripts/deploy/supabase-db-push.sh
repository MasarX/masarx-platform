#!/usr/bin/env bash
set -euo pipefail

cli=$1
output=$2
push_status=$3
log_status=$4

if (( log_status != 0 )); then
  exit "$log_status"
fi

# Match the CLI error header before any printed detail or failed SQL.
failure=$(awk '
  { sub(/\r$/, "") }
  /^Applying migration / {
    migration = ""
    if ($0 ~ /^Applying migration [0-9]+_[[:alnum:]_.-]+\.sql\.\.\.$/) {
      migration = $3
      sub(/\.\.\.$/, "", migration)
    }
  }
  /^ERROR: / {
    if (match($0, /\(SQLSTATE (40P01|55P03)\)$/)) {
      print substr($0, RSTART + 1, RLENGTH - 2), migration
    }
    exit
  }
' "$output")
[[ -n "$failure" ]] || exit "$push_status"
read -r _ sqlstate migration <<< "$failure"

migration_file="supabase/migrations/$migration"
reason=
if [[ -z "$migration" ]]; then
  reason='could not identify the failing migration in the CLI output'
elif [[ ! -f "$migration_file" || -L "$migration_file" ]]; then
  reason='migration file is missing or is not a regular file'
elif ! reason=$(node "$(dirname "$0")/supabase-db-push-retry-check.cjs" "$migration_file" 2>/dev/null); then
  reason='could not inspect the migration file'
fi
if [[ -n "$reason" ]]; then
  printf '::error::Supabase db push will not retry SQLSTATE %s: %s.\n' "$sqlstate" "$reason" >&2
  exit "$push_status"
fi

printf '::warning::Supabase db push failed with SQLSTATE %s while applying %s. Retrying once in 5 seconds.\n' "$sqlstate" "$migration"
sleep 5
"$cli" db push --linked --yes
