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
  BEGIN { migration = "an unidentified migration" }
  { sub(/\r$/, "") }
  /^Applying migration [0-9]+_[[:alnum:]_.-]+\.sql\.\.\.$/ {
    migration = $3
    sub(/\.\.\.$/, "", migration)
  }
  /^ERROR: / {
    if (match($0, /\(SQLSTATE (40P01|55P03)\)$/)) {
      print substr($0, RSTART + 1, RLENGTH - 2) " while applying " migration
    }
    exit
  }
' "$output")
[[ -n "$failure" ]] || exit "$push_status"

printf '::warning::Supabase db push failed with %s. Retrying once in 5 seconds.\n' "$failure"
sleep 5
"$cli" db push --linked --yes
