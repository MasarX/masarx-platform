# Master Test Plan

This matrix tracks what we verify, how we automate it, and what evidence to capture.

## Canonical Gates

- Cloud (CI-equivalent): `ENV_FILE=path/to/cloud-config npm test` (runs `verify:cloud:core`)
- Local (optional): `npm run local:configure` + `npm run local:env` + `npm run local:start` + `npm run local:verify`

## Workflow Matrix

| Area | Key scenarios | Automation | Baseline | Evidence |
| --- | --- | --- | --- | --- |
| Schema & migrations | RLS enabled, policies present, constraints/index contracts | `npm run test:pgtap` | Applied migrations (`npm run db:push`) | `pgtap.log` (or CI pgTAP output) |
| Config validation | Schema registry, provider defaults, template sanity | `npm test` (includes `validate:configs` + `lint:db`) | Migrations applied | `config-validation.log` + db lint output |
| Deterministic seed | Baseline org/client/sender/providers/webhook sources | `npm run seed:small`, `npm run seed:medium`, `npm run seed:large` | Clean environment (cloud project-per-workspace or local reset) | Seed output + spot-check SQL in `SEED_BASELINES.md` |
| Webhook ingest | 200/202 ACK, idempotency replay, HMAC pass/fail, JSON schema toggle | `npm run test:integration -- tests/integration/webhook-ingest.test.js` | Seed baseline + ingest policies | `jest.log` + `webhook_inbox` / `webhook_response_events` rows |
| Outbound queue | Lease/complete lifecycle, retry paths, edge dispatch hooks | `npm run test:integration -- tests/integration/outbound-queue.test.js` | Seed baseline + provider auth config | `jest.log` + `outbound_calls` transitions |
| Geocoding | Primary/fallback/cache/manual-review paths | `npm run test:integration` (geocoding suites) | Seed baseline + geocoding policy | `jest.log` + `geocoding_attempts` / `decision_log` rows |
| Labels | Policy, render, upload, decision trail | `npm run test:integration` (label suites) | Seed baseline + renderer defaults | `jest.log` + label tables + storage evidence |
| RLS isolation | Tenant/client isolation + sensitive tables denied | `npm run test:integration` (rls suites) + pgTAP RLS contracts | Multi-tenant seed baseline | `jest.log` + pgTAP output |
| Performance | Partition routing + p95 targets under CI load profile | `npm run test:load:cloud` | Seed baseline + cloud env | `load.log` + any `tmp/*` artifacts |

## Focused Runs (Jest)

```bash
# Single integration file
ENV_FILE=path/to/cloud-config npm run test:integration -- tests/integration/webhook-ingest.test.js --runInBand

# Single test name pattern
ENV_FILE=path/to/cloud-config npm run test:integration -- --testNamePattern="idempotency" --runInBand
```

