# DEV database apply and recovery

Run [Deploy dev](../../.github/workflows/deploy.yml) from `main`. The [delivery policy](../../DELIVERY.md#deploys) defines the apply guards and approval requirements.

## Dry run and apply

1. Dispatch `mode=dry-run` with `environment=dev` and the approved DEV `project_ref`. If the environment has a configured project reference, the input must match it.
2. Open the successful run summary and record its commit SHA. Verify the pending migration count and, when there are pending migrations, the first and last filenames. Require `order=none` and `over_<limit>_min=false` on the `dry-run:` log line. Stop if the workflow fails, the plan is unknown, or the order or time check fails. The time flag measures the link and dry run. Use the apply summary to measure the apply itself.
3. Compare the dry-run SHA with the current remote `main` tip. If it moved, repeat the dry run and review the new plan. Dispatch `mode=deploy` with `environment=dev` and set `expected_sha` to the verified SHA. The apply guard refuses the run if `main` moves before it can apply.
4. Wait for the deploy summary. Verify the database job and every configured downstream surface, and account for any skipped or failed job. Use the migration evidence in the database summary to confirm the apply. Follow recovery when the database job fails.

## Recover from an unsuccessful apply

1. Keep the apply guard in place while investigating. Record the failing run, commit, and migration evidence from its summary.
2. Run a dry run against the same DEV target and reconcile its plan with the previous attempt. For the exact pending set, compare the migration version prefixes at the inspected commit with the following read-only history query.

   ```sql
   SELECT version
   FROM supabase_migrations.schema_migrations
   ORDER BY version;
   ```

3. Inspect the failed migration for transaction boundaries. A commit within a migration can survive a later failure even when the file has no history row. Verify the effects of each potentially committed block, including definitions and privileges for changed database objects, against the target catalog. For a routine definition use `pg_get_functiondef` with the exact signature. Compare the definition and applicable grants with the SQL at the inspected commit.
4. Resolve the cause of failure and record the reconciled history and catalog evidence. Follow the approved rearm procedure in the [delivery policy](../../DELIVERY.md#deploys). Verify a fresh dry run and repeat the SHA and summary checks above. If apply fails again, leave the guard in place while investigating the new result.
