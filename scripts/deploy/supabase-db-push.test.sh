#!/usr/bin/env bash
set -euo pipefail

wrapper=$(dirname "$0")/supabase-db-push.sh
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT

cat > "$fixture/supabase" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ $# == 4 && "$*" == 'db push --linked --yes' && "$NO_COLOR" == 1 ]]
calls=$(<"$CALLS")
printf '%s\n' "$((calls + 1))" > "$CALLS"
code=$FIRST_SQLSTATE
if (( calls > 0 )); then
  code=$SECOND_SQLSTATE
fi
if [[ $code == ok ]]; then
  echo 'Finished supabase db push.'
  exit 0
fi
echo 'Applying migration 20261019020900_previous.sql...' >&2
echo 'Applying migration 20261019021000_automation_marketplace_control_plane_v1.sql...' >&2
printf 'ERROR: synthetic database error (SQLSTATE %s)\n' "$code" >&2
printf 'At statement: 111\nSELECT %s;\n' "'quoted SQLSTATE 40P01)'" >&2
exit 23
EOF
chmod +x "$fixture/supabase"

sleep() {
  [[ $# == 1 && "$1" == 5 ]]
  printf 'waited\n' >> "$WAITS"
}
export -f sleep
export CALLS="$fixture/calls" WAITS="$fixture/waits"

check() {
  local label=$1 first=$2 second=$3 expected_status=$4 expected_calls=$5 status=0
  printf '0\n' > "$CALLS"
  : > "$WAITS"
  FIRST_SQLSTATE=$first SECOND_SQLSTATE=$second bash "$wrapper" "$fixture/supabase" > "$fixture/out" 2>&1 || status=$?
  if [[ $status != "$expected_status" || $(<"$CALLS") != "$expected_calls" ]]; then
    cat "$fixture/out" >&2
    printf '%s failed (status %s, calls %s)\n' "$label" "$status" "$(<"$CALLS")" >&2
    return 1
  fi
  if (( expected_calls == 2 )); then
    [[ $(wc -l < "$WAITS") -eq 1 ]]
    [[ $(grep -c '^::warning::' "$fixture/out") -eq 1 ]]
    grep -Fq "::warning::Supabase db push failed with SQLSTATE $first while applying 20261019021000_automation_marketplace_control_plane_v1.sql" "$fixture/out"
  else
    [[ ! -s "$WAITS" ]]
    if grep -q '^::warning::' "$fixture/out"; then
      return 1
    fi
  fi
  printf 'PASS %s\n' "$label"
}

check 'success' ok ok 0 1
check '40P01 then success' 40P01 ok 0 2
check '40P01 twice' 40P01 40P01 23 2
check 'other error with code in printed statement' 23505 ok 23 1
check '55P03 then success' 55P03 ok 0 2
check '55P03 twice' 55P03 55P03 23 2
