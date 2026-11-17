# Workflow: Load & Performance Validation

## Objective

Validate partition routing and core write performance under realistic load, with
thresholds driven by environment and Supabase tier. Defaults target a "strict"
profile; free-tier runs can relax via env without changing code.

## Command

```bash
node scripts/data/seed-test-data.js 10000  # ensures realistic dataset
npm run test:load:cloud                   # Docker/xk6 based load test (cloud DB)
```

If Docker is blocked locally, dispatch the load workflow in CI and pass a ref:

```bash
gh workflow run "Weekly Load Test" -f ref=<branch-or-sha>
```

## What the Script Does

1. Builds a k6 binary with the `xk6-sql` core + Postgres driver inside Docker.
   - If Docker is unavailable, falls back to a local xk6 build (Go required).
   - Docker check/run timeouts are env-driven so local runs fail fast when Docker
     is offline.
2. Resolves a DATABASE_URL for load tests:
   - Uses `LOADTEST_DATABASE_URL` if set.
   - Else derives a DSN from `SUPABASE_PROJECT_ID`, `SUPABASE_DB_PASSWORD`,
     `SUPABASE_POOLER_HOST`, `SUPABASE_POOLER_PORT` (transactional pooler).
   - Falls back to `DATABASE_URL` only if no pooler env is present.
3. Launches `tests/load/partition-performance.js`, which:
   - Picks a pool of existing clients/organizations from seeded data.
   - Runs concurrent shipment inserts and optional geocoding cache inserts.
   - Logs partition name distribution to confirm hash-based spreading.
4. Reports the summary and threshold evaluation in the k6 CLI output.

## Configuration (env-driven)

`tests/load/partition-performance.js` is fully driven by environment:

- `PARTITION_VUS`
  - Virtual users (concurrent connections).
  - Default: `10` in code; override in `.env.cloud` (e.g. `2` for CI smoke, `10` for free tier).

- `PARTITION_DURATION`
  - Test duration string (`30s`, `1m`, etc.).
  - Default: `1m`.

- `PARTITION_P95_MS`
  - Target `iteration_duration p(95)` in milliseconds.
  - Default: `3000` (strict baseline).
  - Free-tier example: `15000` to tolerate cold starts and shared tenancy.

- `PARTITION_CHECK_RATE`
  - Minimum acceptable `checks` success ratio.
  - Default: `0.99` (99%).
  - Free-tier example: `0.95` to allow occasional timeouts under noisy neighbors.

- `PARTITION_CLEANUP`
  - Controls whether the teardown deletes the inserted `LOAD-<run_id>-*` shipments.
  - Default: enabled (teardown cleans up).
  - Set to `0` to preserve rows for debugging (be deliberate; prefer scripted cleanup over manual SQL).

All of these are read from `__ENV` at runtime; nothing is hardcoded per project
or tier. Adjust them via `config/env/.env.cloud` instead of editing tests.

Optional load-test runner controls:

- `LOAD_TEST_DOCKER_CHECK_TIMEOUT_MS`
  - Max time to wait for `docker info` before failing over to local xk6.
  - Default: `10000` (10s).

- `LOAD_TEST_DOCKER_TIMEOUT_MS`
  - Max time for the Docker-based xk6 run before falling back.
  - Default: `600000` (10m).

Example free-tier profile in `.env.cloud`:

```dotenv
PARTITION_VUS=10
PARTITION_DURATION=1m
PARTITION_P95_MS=15000
PARTITION_CHECK_RATE=0.95
```

## Pass Criteria

Given the env above, the load test passes when:

- `checks` rate = `PARTITION_CHECK_RATE`.
- `iteration_duration p(95)` < `PARTITION_P95_MS`.
- No systemic connection errors (e.g. DNS failures, pooler auth errors).

## Post-Run Spot Checks

```sql
SELECT count(*) FROM webhook_inbox WHERE created_at > now() - interval '5 minutes';
SELECT response_outcome, count(*) FROM webhook_response_events GROUP BY response_outcome;
```

