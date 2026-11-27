#!/usr/bin/env bash
set -euo pipefail

cli=$1
output=$2
push_status=$3
log_status=$4

if (( log_status != 0 )); then
  exit "$log_status"
fi

# The CLI prints the error header, optional detail, then a statement index and SQL.
failure=$(awk '
  { sub(/\r$/, "") }
  !failed && /^Applying migration / {
    migration = ""
    if ($0 ~ /^Applying migration [0-9]+_[[:alnum:]_.-]+\.sql\.\.\.$/) {
      migration = $3
      sub(/\.\.\.$/, "", migration)
    }
  }
  !failed && /^ERROR: / {
    if (!match($0, /\(SQLSTATE (40P01|55P03)\)$/)) exit
    sqlstate = substr($0, RSTART + 10, 5)
    failed = 1
    next
  }
  failed && /^At statement: [0-9]+$/ {
    if (seen++) ambiguous = 1
    statement = $3
    read_sql = 1
    next
  }
  failed && /^ERROR: / { ambiguous = 1 }
  read_sql {
    if ($0 ~ /[^[:space:]]/) site = "migration"
    if (tolower($0) ~ /^[[:space:]]*insert[[:space:]]+into[[:space:]]+supabase_migrations[.]schema_migrations([[:space:]]|\()/) site = "history"
    read_sql = 0
  }
  END {
    if (failed) print sqlstate, (migration ? migration : "-"), (site && !ambiguous ? site : "unknown"), statement
  }
' "$output")
[[ -n "$failure" ]] || exit "$push_status"
read -r sqlstate migration site statement <<< "$failure"

migration_file="supabase/migrations/$migration"
reason=
if [[ "$migration" == - ]]; then
  reason='could not identify the failing migration in the CLI output'
elif [[ "$site" == history ]]; then
  reason='migration history write failed after the migration may have committed'
elif [[ "$site" != migration ]]; then
  reason='could not identify the failing statement in the CLI output'
elif [[ ! -f "$migration_file" || -L "$migration_file" ]]; then
  reason='migration file is missing or is not a regular file'
elif ! reason=$(node "$(dirname "$0")/supabase-db-push-retry-check.cjs" "$migration_file" "$statement" 2>/dev/null); then
  reason='could not inspect the migration file'
fi
if [[ -n "$reason" ]]; then
  printf '::error::Supabase db push will not retry SQLSTATE %s: %s.\n' "$sqlstate" "$reason" >&2
  exit "$push_status"
fi

printf '::warning::Supabase db push failed with SQLSTATE %s while applying %s. Retrying once in 5 seconds.\n' "$sqlstate" "$migration"
sleep 5
"$cli" db push --linked --yes
