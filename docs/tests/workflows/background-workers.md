# Workflow: Background Jobs & Worker Registry

## Scope

- Partition maintenance helpers (`create_next_partitions`, `expand_hash_partitions`, etc.).
- Workflow ingestion worker (`run_webhook_processor_worker`) progressing pending runs.
- Workflow run linkage from `workflow_intake_webhook` -> `workflow_runs`.

## Automated Coverage

| Area | Command | Files |
| --- | --- | --- |
| Partition functions execute and remain deterministic | `npm run test:integration` | `tests/integration/partition-functions.test.js` |
| RLS & settings ladder for workers | `npm run test:integration` | `tests/integration/settings-resolution.test.js` |
| Webhook intake to workflow linkage | `npm run test:pgtap` | `supabase/tests/pgtap/004_webhook_intake.sql` |
| Worker progression respects throttle + run stewardship | `npm run test:integration` | `tests/integration/workflow-intake.test.js` |

## Manual SQL Snippets

```sql
SELECT worker_key, cron_expression, enabled
FROM worker_registry
ORDER BY worker_key;

SELECT id, workflow_status, context
FROM workflow_runs
WHERE context ? 'webhook_id'
ORDER BY created_at DESC
LIMIT 20;
```

## Extending

When a new worker is added:

1. Seed deterministic metadata in `scripts/data/seed-test-data.js`.
2. Add pgTAP assertions for RLS/policy defaults.
3. Extend (or create) an integration test verifying the worker advances the expected workflow steps.
4. Update this document with the scenario + commands.
