#!/usr/bin/env bash
set -euo pipefail

cli=$1
output=$(mktemp)
trap 'rm -f "$output"' EXIT

export NO_COLOR=1
if "$cli" db push --linked --yes 2>&1 | tee "$output"; then
  exit 0
else
  statuses=("${PIPESTATUS[@]}")
fi

if (( statuses[1] != 0 )); then
  exit "${statuses[1]}"
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
[[ -n "$failure" ]] || exit "${statuses[0]}"

printf '::warning::Supabase db push failed with %s. Retrying once in 5 seconds.\n' "$failure"
sleep 5
"$cli" db push --linked --yes
