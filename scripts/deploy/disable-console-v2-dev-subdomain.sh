#!/usr/bin/env bash
set -euo pipefail

if [[ ! "${CLOUDFLARE_ACCOUNT_ID:-}" =~ ^[[:xdigit:]]{32}$ ||
      ! "${CLOUDFLARE_WORKER_CONSOLE_V2:-}" =~ ^[a-zA-Z0-9_-]+$ ||
      ! "${CLOUDFLARE_API_TOKEN:-}" =~ ^[a-zA-Z0-9._~+/-]+=*$ ]]; then
  printf '%s\n' '::error::Missing or invalid Cloudflare configuration' >&2
  exit 1
fi

request() {
  local method=$1 attempt response status body transfer_ok codes
  shift
  for attempt in 1 2 3; do
    transfer_ok=false
    # Send the header and account URL through stdin so neither is in curl's arguments.
    if response=$(
      printf 'url = "%s"\nheader = "Authorization: Bearer %s"\n' \
        "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$CLOUDFLARE_WORKER_CONSOLE_V2/subdomain" \
        "$CLOUDFLARE_API_TOKEN" |
        curl --disable --silent --connect-timeout 5 --max-time 15 --request "$method" \
          --write-out '\n%{http_code}' --config - "$@" 2>/dev/null
    ); then
      transfer_ok=true
    fi
    status=${response##*$'\n'}
    [[ "$status" =~ ^[1-5][0-9]{2}$ ]] || status=000
    body=${response%$'\n'*}
    if [[ "$status" != 5?? || "$attempt" == 3 ]]; then
      break
    fi
    sleep "$attempt"
  done

  if [[ "$transfer_ok" == true && "$status" == 2?? ]] &&
    jq -es --arg method "$method" '
      length == 1 and (.[0] | .success == true and
        ($method == "POST" or (.result.enabled == false and .result.previews_enabled == false)))
    ' <<< "$body" >/dev/null 2>&1; then
    return 0
  fi

  codes=$(jq -rs '[.[0].errors[]? | .code | numbers | select(floor == .)] | join(",")' <<< "$body" 2>/dev/null) || codes=
  printf '::error::HTTP %s API error codes %s\n' "$status" "${codes:-none}" >&2
  return 1
}

request POST --json '{"enabled":false,"previews_enabled":false}'
request GET
printf '%s\n' 'enabled=false previews_enabled=false' >> "$GITHUB_STEP_SUMMARY"
