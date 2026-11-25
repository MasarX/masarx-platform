#!/usr/bin/env bash
set -euo pipefail
umask 077

cd "$(git rev-parse --show-toplevel)"
sha=$(git rev-parse HEAD)
if [[ -e result.json || -L result.json || -e nightly.log || -L nightly.log ]]; then
  echo 'Nightly evidence already exists in this checkout.' >&2
  exit 1
fi
started=$(node -p 'new Date().toISOString()')
journal=$(mktemp)
result=0
stack=
network=
interrupted=0
finish() {
  local code=$?
  trap - EXIT
  if [[ -n $stack && -f $stack/supabase/config.toml ]] &&
     ! run_suite 'Stop local Supabase' error '' supabase stop --workdir "$stack" --no-backup; then
    code=1
  fi
  if [[ -n $network ]] && ! run_suite 'Remove local fixture network' error '' docker network rm "$network"; then
    code=1
  fi
  if [[ $interrupted -ne 0 ]]; then
    node scripts/ci/nightly-result.cjs record "$journal" 'Nightly interrupted' error >/dev/null
  elif [[ $code -ne 0 && $result -eq 0 ]]; then
    node scripts/ci/nightly-result.cjs record "$journal" 'Nightly setup' error >/dev/null
  fi
  node scripts/ci/nightly-result.cjs finish "$journal" "$sha" "$started" "$code"
  exit "$code"
}
trap finish EXIT
trap 'interrupted=1; exit 143' TERM
trap 'interrupted=1; exit 130' INT
export CI=true ENV_FILE=/dev/null ENV_FILE_APPEND=0 ENV_FILE_OVERRIDE=0
export NPM_CONFIG_IGNORE_SCRIPTS=true NPM_CONFIG_FETCH_RETRIES=0 JEST_RETRY_TIMES=0
export EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1

run_suite() {
  local name=$1 status=$2 report=$3
  shift 3
  printf '[nightly] start %s\n' "$name" >> nightly.log
  if "$@" >> nightly.log 2>&1; then status=green; fi
  if ! status=$(node scripts/ci/nightly-result.cjs record "$journal" "$name" "$status" "$report"); then
    echo 'Nightly could not record suite status.' >&2
    exit 1
  fi
  printf '[nightly] %s %s\n' "$status" "$name" | tee -a nightly.log
  if [[ $status != green ]]; then result=1; fi
  [[ $status == green ]]
}

check_targets() {
  node - <<'NODE'
const { assertLoopbackOnly } = require('./scripts/ops/ci/cloud-pool-db-local.js');
assertLoopbackOnly(process.env, 'nightly test environment');
for (const key of ['CONSOLE_BASE_URL', 'PORTAL_BASE_URL', 'FIELDOPS_BASE_URL',
  'FIELDOPS_MOBILE_BASE_URL', 'VERIFY_BASE', 'LANDING_BASE_URL']) {
  if (process.env[key]) assertLoopbackOnly({ SUPABASE_URL: process.env[key] }, key);
}
NODE
}

check_node_version() {
  node -e 'const fs = require("node:fs"); if (process.versions.node !== fs.readFileSync(".nvmrc", "utf8").trim()) throw new Error("Use the Node version in .nvmrc");'
}

create_fixture_network() {
  local name="${NIGHTLY_JOB##*/}"
  name=${name#.}
  command -v supabase >/dev/null && command -v docker >/dev/null || return 1
  docker info --format '{{json .SecurityOptions}}' | grep -q 'name=rootless' || return 1
  docker network create --driver bridge -o com.docker.network.bridge.host_binding_ipv4=127.0.0.1 "$name" || return 1
  network=$name
  export NIGHTLY_DOCKER_NETWORK="$network"
}

start_local_stack() {
  local settings setting project
  stack=$(mktemp -d) || return 1
  project=$(node scripts/ci/nightly-local.cjs prepare "$stack") || return 1
  node scripts/ci/nightly-local.cjs network "$network" || return 1
  supabase --network-id "$network" start --workdir "$stack" -x studio,inbucket,logflare,vector || return 1
  node scripts/ci/nightly-local.cjs bindings "$project" || return 1
  settings=$(supabase status --workdir "$stack" -o json | node scripts/ci/nightly-local.cjs env) || return 1
  while IFS= read -r setting; do export "$setting"; done <<< "$settings"
}

run_browser() {
  local name=$1 report="ci-reports/$2.json"
  shift 2
  PLAYWRIGHT_JSON_OUTPUT_NAME="$PWD/$report" run_suite "$name" red "$report" "$@" \
    --forbid-only --retries=0 --reporter=list,json
}

console_v2() (
  local mode=$1 script=$2
  shift 2
  # objectives:allow LOCALHOST Justification: the Console V2 Playwright config uses this local Vite origin.
  export VERIFY_BASE=http://127.0.0.1:5175
  export VITE_USE_SEED="$mode"
  setsid npm run dev --workspace @masarx/console-v2 -- --host 127.0.0.1 --strictPort &
  local service=$!
  trap 'kill -- "-$service" 2>/dev/null || :; wait "$service" 2>/dev/null || :' EXIT
  node scripts/ci/nightly-local.cjs wait "$VERIFY_BASE" || return 1
  npm run "$script" --workspace @masarx/console-v2 "$@"
)

# Keep the log inside the job folder until the clean-checkout check completes.
if ! node scripts/ci/nightly-local.cjs fresh-main "$sha" >> "$journal.preflight" 2>&1; then
  node scripts/ci/nightly-result.cjs record "$journal" 'Fresh public main checkout' error >/dev/null
  printf '[nightly] error Fresh public main checkout\n' > nightly.log
  cat "$journal.preflight" >> nightly.log
  result=1
  exit 1
fi
export GITHUB_SHA="$sha"
if ! run_suite 'Pinned Node version' error '' check_node_version; then exit 1; fi
if ! run_suite 'Nightly suite inventory' error '' node scripts/ci/nightly-coverage.cjs; then exit 1; fi
if ! run_suite 'Empty known failure baseline' error '' test ! -e config/ci/known-failures.txt; then exit 1; fi
if ! run_suite 'Loopback fixture safety' error '' check_targets; then exit 1; fi
if ! run_suite 'Available local fixture ports' error '' node scripts/ci/nightly-local.cjs ports-free; then exit 1; fi
if ! run_suite 'Locked dependency install' error '' npm ci --ignore-scripts --no-audit --no-fund; then exit 1; fi
mkdir -p ci-reports

# nightly-covers: test:unit test:ui test:ui:fieldops
run_suite 'Jest unit' red ci-reports/jest-results.unit.json node scripts/ci-hosted/jest.cjs unit || :
run_suite 'Jest UI' red ci-reports/jest-results.ui.json node scripts/ci-hosted/jest.cjs ui || :
run_suite 'FieldOps Jest UI' red ci-reports/fieldops-jest.json npm run test:ui:fieldops -- --json --outputFile=ci-reports/fieldops-jest.json || :
run_suite 'Console V2 Vitest' red ci-reports/console-v2-vitest.json npm run test --workspace @masarx/console-v2 -- \
  --reporter=default --reporter=json --outputFile.json="$PWD/ci-reports/console-v2-vitest.json" || :

# nightly-covers: test:pgtap test:pgtap:local test:bootstrap:pgtap-fixtures
if run_suite 'Disposable loopback fixture network' error '' create_fixture_network; then
  shard_count=$(node -p "require('./scripts/ci-hosted/database-result.cjs').PGTAP_SHARD_COUNT")
  reports=ci-reports/database-result
  mkdir -p "$reports/build" "$reports/shards"
  build_result=failure
  if run_suite 'From-zero database build' red '' node scripts/ci-hosted/backend.cjs &&
    [[ -f ci-reports/backend.json ]]; then
    mv ci-reports/backend.json "$reports/build/"
    build_result=success
  fi
  pgtap_result=success
  for ((shard = 1; shard <= shard_count; shard++)); do
    destination="$reports/shards/pgtap-$shard-1"
    mkdir -p "$destination"
    if ! run_suite "pgTAP shard $shard of $shard_count" red ci-reports/pgtap-files.json env \
      PGTAP_SHARD="$shard/$shard_count" JOB_STARTED_AT="$(date +%s)" node scripts/ci-hosted/backend.cjs; then
      pgtap_result=failure
    fi
    for report in ci-reports/pgtap* ci-reports/postgres-server.log; do
      if [[ -f $report ]]; then mv -- "$report" "$destination/"; fi
    done
  done
  run_suite 'Complete database coverage' red '' env BUILD_RESULT="$build_result" DATABASE_PRESENT=true \
    PGTAP_RESULT="$pgtap_result" node scripts/ci-hosted/database-result.cjs || :
else
  exit 1
fi

stack_ready=0
# nightly-covers: test:integration test:bootstrap:integration-fixtures test:edge-smoke
if run_suite 'Start local Supabase' error '' start_local_stack &&
  run_suite 'Seed synthetic integration fixtures' error '' npm run test:bootstrap:integration-fixtures; then
  stack_ready=1
  run_suite 'Jest integration' red ci-reports/jest-results.integration.json env RUN_LOCAL_EDGE_TESTS=true RUN_EDGE_E2E=true \
    RUN_RLS_INTEGRATION_TESTS=true RUN_MATRIX_E2E=true RUN_LABELS_WEBHOOK_TESTS=true \
    RUN_WEBHOOK_HTTP_TESTS=true RUN_API_GATEWAY_HTTP_TESTS=true \
    node scripts/ci-hosted/jest.cjs integration || :
  run_suite 'Edge smoke' red '' env RUN_LOCAL_EDGE_TESTS=true EDGE_SMOKE_REQUIRED=1 npm run test:edge-smoke || :
fi

browser=(node -e 'require("node:child_process").execFileSync(process.execPath, [require.resolve("@playwright/test/cli"), "install", "chromium"], { stdio: "inherit" })')
if run_suite 'Install locked Chromium' error '' "${browser[@]}"; then
  # nightly-covers: test:e2e playwright.config.ts test:e2e:fieldops playwright.fieldops.config.ts
  # nightly-covers: test:e2e:fieldops-mobile tests/e2e/fieldops-mobile/playwright.config.ts
  # nightly-covers: test:e2e:console test:e2e:console:seed test:e2e:console:live test:e2e:console:live:local apps/console-v2/playwright.e2e.config.ts
  # nightly-covers: test:a11y test:visual apps/console-v2/playwright.a11y.config.ts apps/console-v2/playwright.visual.config.ts
  # nightly-covers: test:e2e:landing playwright.landing.config.ts scripts/ci-hosted/playwright.landing.config.cjs
  if [[ $stack_ready -eq 1 ]]; then
    run_browser 'Console Portal shared and accessibility E2E' console-portal env -u CI NIGHTLY_LOCAL_E2E=1 RUN_EDGE_E2E=true \
      E2E_VISUAL=1 E2E_ALLOW_MUTATIONS=1 E2E_MUTATION_ENV=dedicated npm run test:e2e -- || :
    run_browser 'FieldOps E2E' fieldops npm run test:e2e:fieldops -- || :
    run_browser 'FieldOps mobile web E2E' fieldops-mobile env RUN_FIELDOPS_E2E=1 npm run test:e2e:fieldops-mobile -- || :
    if run_suite 'Build local FieldOps web export' error '' npm exec --offline --workspace @masarx/fieldops -- \
      expo export --platform web --output-dir "$stack/fieldops-web"; then
      run_browser 'FieldOps PWA' fieldops-pwa env FIELDOPS_PWA_SMOKE=1 FIELDOPS_WEB_EXPORT_DIR="$stack/fieldops-web" \
        npm run test:e2e:fieldops -- || :
    fi
    E2E_CONSOLE_LIVE=1 run_browser 'Console V2 backend E2E' console-v2-backend console_v2 false test:e2e:console:live -- || :
  fi
  run_browser 'Console V2 seed E2E' console-v2-seed console_v2 true test:e2e:console:seed -- || :
  run_browser 'Console V2 accessibility' console-v2-a11y console_v2 true test:a11y -- || :
  run_browser 'Console V2 visual' console-v2-visual console_v2 true test:visual -- || :
  if run_suite 'Landing build' error '' node scripts/ci-hosted/tasks.cjs build landing; then
    run_browser 'Landing E2E' landing npm exec --offline -- playwright test -c scripts/ci-hosted/playwright.landing.config.cjs || :
  fi
fi
exit "$result"
