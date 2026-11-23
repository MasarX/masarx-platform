# MasarX: delivery

The Delivery Lead owns this file. Change it through a reviewed PR.

Follows engineering standard v1.10.

## Branching and merging

- The `main` queue permits one concurrent build. Use it without admission caps, drains or bypasses. Keep one migration item and one non-migration item in progress at a time.
- The manual merge hold is retired. The DEV apply guard (G1–G3) protects DEV database applies.
- Changes on the risk paths in [AGENTS.md](AGENTS.md#risk-paths-need-one-independent-review-before-landing) need green CI and one independent review of the full diff, recorded on the PR against its exact head. No code-owner or lead approval is required. GitHub can require an extra approval for unattributed changes.
- Use the approved tree-publisher App helper for authenticated GitHub work. If the helper fails, stop and report it to Delivery. Keep installation tokens and signing material out of output and shared artifacts. The owner login is reserved for approved settings changes and release tags.
- Leave queue admission and merging to the Delivery Lead unless your task explicitly authorizes them for the PR. Push changes through topic branches. Never force-push, rewrite public history or push directly to `main`. Change repository or organization settings only through an approved packet naming the exact setting and target value. Record the before and after values.
- Changes to `main` merge only through the merge queue, using `SQUASH`. The required checks are `ci-gate` and CodeQL code scanning. CodeQL alerts of high severity or above block merging. Before enqueueing, verify the required checks and any applicable risk-path review for the exact PR head and the PR's issue reference (`Closes #n` or `Refs #n`). The App sets `expectedHeadOid` to the reviewed SHA. Keep auto-merge off. If the head moves or a review sends the PR back, disable auto-merge if set, dequeue it (`dequeuePullRequest`), and confirm no queue entry remains. Verify the queued head still matches the reviewed SHA.
- At push time, assign a fresh migration timestamp block above the newest migration on `main` and keep its files in landing order. A rename-only re-stamp needs no new review. Compare the pre-stamp and re-stamped commits. Verify every migration is `R100` in `git diff -M --name-status` and has zero content lines in `git diff -M --numstat`. Record the existing review against the resulting SHA. The append-only and ordering gate is in [migrations.cjs](scripts/ci-hosted/migrations.cjs).

## Checks

| Workflow | Work | Job limits (minutes) |
| --- | --- | --- |
| [CI](.github/workflows/public-ci.yml) | PR static checks and affected database, lint, typecheck, Jest, UI, build and Landing E2E jobs. The base version of [changes.cjs](scripts/ci-hosted/changes.cjs) owns the shared inputs and fallback. [selfcheck.cjs](scripts/ci-hosted/selfcheck.cjs) checks its routing. Prove affected-job selection when changing it by hiding a representative change from the selector once and confirming CI reports the missed coverage. The merge group runs the full hosted suite on the combined tree. Dependency review is PR-only. Manual dispatch can regenerate visual baselines. `ci-gate` aggregates the job results. | Database build and pgTAP 20 each, database result and append-only 5 each, lint/typecheck/unit/UI 20 each, Console and Portal/Landing builds 35 each, Landing E2E 30, visual baselines 60, dependency review and gate 5 each. |
| [CodeQL](.github/workflows/codeql.yml) | Scans JavaScript/TypeScript and Actions on PRs into `main`, queue groups and `main` pushes. The Monday schedule also prunes Actions caches. | Analysis 20. Cache pruning has a 5-minute step limit. |
| [Verify prebuilt](.github/workflows/verify-prebuilt.yml) | Checks the Console and Portal prebuilt packaging contract on matching PR paths. | 15. |
| [Deploy DEV](.github/workflows/deploy.yml) | Applies the database, deploys registered Edge Functions and deploys Console, Portal, Landing and ingress. Manual modes also support a database dry run and API schema diagnostics. The manual DEV-only `renderer-jwt-mint` mode rotates the renderer invoke credential with a fixed 7-day token. | API schemas 10, renderer JWT mint 10, database 180, dry run 90, Console and Portal 35 each, Landing 20, ingress 15, summary 5. |
| [DEV outbound probe](.github/workflows/dev-outbound-probe.yml) | Measures synthetic outbound dispatch and counts failures by fixed reason. | 12, including up to 10 minutes for queued work. |
| [DEV design sweep users](.github/workflows/dev-sweep-users.yml) | Refreshes the synthetic sign-in accounts and delivers the encrypted credential artifact described under [Signed-in DEV sweep](#signed-in-dev-sweep). | 5. |
| [Guarded egress probe](.github/workflows/guarded-egress-probe.yml) | Manual DEV and staging diagnostic that currently reports `not_configured`. | 5. |
| [Provenance on tag](.github/workflows/provenance-on-tag.yml) | Verifies the tagged commit and builds, attests and publishes the static Landing archive. | Verify 10, build and publish 20. |

- Set job and step limits from measured run and job timings, plus a margin.
- CI runs only on free GitHub-hosted runners. Get the owner's approval before spending money or using a paid service. Use at most 20 jobs per CI run. The hosted browser suite covers Landing E2E. Full Console, Portal and FieldOps journeys need separate qualification.
- PR wall time uses the workflow start and the `ci-gate` result timestamps. Track p50 and p90 on the project board's CI-FAST item. Timing-weighted pgTAP shards were the first change ([#173](https://github.com/MasarX/masarx-platform/pull/173)).
- Keep queue-entry-to-completion wall time under 25 minutes. Track PR-open-to-merge time alongside PR wall time and queue wall time. Use a ±10% tolerance for timing comparisons unless the repository defines another tolerance.
- Use GitHub Actions job durations and counts for runner-minutes and job count. [hosted-usage-report.js](scripts/ops/ci/hosted-usage-report.js) summarizes runner usage exports. Gap: Standalone budgets for runner-minutes and time to merge are undefined.
- Measure product speed in a browser on production-class hardware against a written usable state. Before tuning a slow action, capture its request waterfall and client and server timings.
- Before replacing a CI tool, compare both tools on the same inputs and record any lost coverage. If a change leaves `main` or the queue red for 30 minutes, revert it through the protected PR path. Track flaky tests as high-priority bugs and fix or revert the cause.

## Test policy

- Test each changed behavior with a regression that fails before the fix. Use unit tests for logic, integration tests for affected database, queue and API boundaries, and end-to-end tests for core user jobs. Freeze clocks and wait for observable state. Preserve product guards when fixing tests. Trunk test edits need a recorded Master exception. A replacement preserves the existing assertions or identifies the design decision that retired them. Removal also requires two weeks of evidence that the test only detects change. Keep authorization, privacy, migration and concurrency tests.
- Fix failures at their source. New failures block landing. Never rerun an unchanged failure or use retries, skips or longer timeouts to turn a failing check green. The existing exceptions are listed under [Deviations](#deviations).
- Use local services and mocks for routine tests. The cloud qualification checks are listed under [Deviations](#deviations).
- Hosted Jest ([jest.cjs](scripts/ci-hosted/jest.cjs)) reads the target-base known-failure baseline at `config/ci/known-failures.txt`. A missing baseline is empty. The file is absent on `main`. A candidate can retain or remove target-base entries.
- Only `npm run verify:cloud:e2e-gate` reads the [UI flake quarantine](config/ci/ui-flake-quarantine.json) for its cloud E2E summary outside hosted CI. Each entry carries an owner and expiry (`burn_down_by`).
- [database-result.cjs](scripts/ci-hosted/database-result.cjs) requires all six pgTAP shards and an exact count and name match against the SQL test inventory. [database-selfcheck.cjs](scripts/ci-hosted/database-selfcheck.cjs) probes missing and incorrect coverage.

## Environments

- `ci` runs per change and creates an isolated database with generated fixtures when the database lane runs.
- `dev` hosts the integration database and receives deployments on merges to `main`. Use generated fixtures for validation.
- `stg` is the GitHub environment for production-like qualification with approved test data. The deploy gate is pending.
- `prod` is configured for production data and approved releases. Production deployments are paused.
- Keep each environment's data separate. Use generated fixtures for tests.

### Signed-in DEV sweep

Dispatch [DEV design sweep users](.github/workflows/dev-sweep-users.yml) from `main` with `environment=dev`. Each successful dispatch refreshes the passwords for all three accounts. Use the successful run ID before the encrypted artifact expires after one day.

Run `node scripts/dev/fetch-sweep-credentials.mjs --run <id> --key <path> --out <path>` with an authorized GitHub CLI and OpenSSL on `PATH`. Set `GH_CLI` to the GitHub CLI executable if needed. Choose a new output file outside Git worktrees, feed it directly to the sweep runner and remove it after the sweep. Keep credential entry and the file out of logs, captures and issues.

The sweep covers the deployed Console and Portal from the `console` and `portal` jobs in [Deploy DEV](.github/workflows/deploy.yml). Sign in with the normal email and password forms. Start at the Console dashboard with `finance_viewer` and Portal Shipments with `sender_user`.

Use the synthetic tenant's read-only `dispatcher` account for Console `/operations/pickups/waves`, `/operations/pickups/requests`, `/operations/routes` and `/resources/warehouse_transfers/new`. The pickup ledgers and route workspace can be reviewed in read-only mode. The transfer manifest form renders with its lookup inputs disabled. Sweep the available states without submitting forms. The [role configuration](config/dev/sweep-roles.json) lists the allowed permissions.

## Releases

- The tag workflow verifies first-parent history on `main` and qualifying exact-SHA `ci-gate` evidence before building and attesting the static Landing archive. It publishes the archive and checksums to the GitHub Release with static artifact notes. The Delivery Lead updates those notes from the milestone's closed issues and then closes the milestone.
- GitHub's active `release-tags-create` and `release-tags-immutable` rulesets restrict tag creation and protect `v*` tags from updates and deletion.
- Release tags (`vX.Y.Z` and `vX.Y.Z-rc.N`) are annotated and are created with the owner's login, the organization admin that `release-tags-create` allows, as the engineering standard permits for tag creation. The App never creates release tags.
- Before creating a tag, verify against GitHub that the commit is in the first-parent history of `main` and that a `ci-gate` check run succeeded on that exact SHA. After creating the tag, read back the tag ref, the annotated tag object it points to, and the commit the tag object points to.
- For a hotfix, cut from the deployed tag, test the fix, get the owner's explicit approval before a production deploy, and merge the deployed fix forward through the protected PR path.

## Deploys

The v0.2.0 production deploy plan uses the same renderer signing key derivation as DEV, HMAC-SHA256 of the production project JWT secret with the versioned `masarx-renderer-sign-v1` label. The operator runs the derivation on the operator machine and installs the key in the production Edge secret store. Production signing material stays on the server and never enters GitHub.

- DEV deploys run from `main` only. The database job serializes applies in one concurrency group with cancellation disabled. Its configuration guard checks whether deployment is configured. The database merge gate is hosted from-zero replay plus pgTAP. Verify the DEV apply after every migration merge and retain the merged SHA, deploy result and applied migration evidence.
- The [manual DEV outbound probe](.github/workflows/dev-outbound-probe.yml) shares the database apply concurrency group. It runs 20–50 synthetic jobs through inline dispatch and one through the scheduled outbound worker, reports aggregate create-to-completion timings, and requires a leased Edge completion for the worker job. The synthetic fixture and jobs tagged `dev-outbound-probe` remain in DEV for audit.
- The M6 DEV apply guards are active in [apply-guard.cjs](scripts/deploy/apply-guard.cjs) and the deploy workflow.
  - G1: Skip a superseded push when a newer deploy run targets the current tip of `main`. Refuse the apply if the replacing run ended without success or failure.
  - G2: Stop applies if the latest attempt in the 30-day history was unsuccessful, until `DEV_DB_REARMED_AT` is set to a valid timestamp later than that attempt's completion and no later than the current time. Treat a completed database job with missing step records as a possible apply attempt.
  - G3: Before a manual apply, require `expected_sha`, the run SHA and the current `main` tip to match.
  - G4: Once apply starts, write a sanitized apply summary on exit, including failure, and remove the temporary environment file and raw apply log.
- Review each release gate once and record its GO. The Portfolio Lead gives the GO for non-production gates. Once approved, the gate releases each passing change automatically and writes an audit row. A new kind of change needs a new GO.
- The routine DEV deploy audit row is the workflow run summary. It includes the G1–G3 guard decisions, the G4 apply summary and the final job's per-surface results table.
- Each production deploy requires the owner's explicit approval. Production deployments are paused while its gate is being built. Verify a production backup before every production deploy. Keep the previous version ready, check health after deploy and roll back immediately on failure.
- Gap: No production rollback command or staging/production deploy audit row is defined.

## Security

- The Delivery Lead acts on Dependabot, code scanning and secret scanning alerts from both default and generic patterns. Record new high or critical findings the same day. Report vulnerabilities through the repository's private reporting channel. [dependabot.yml](.github/dependabot.yml) configures weekly grouped npm and Actions updates.
- Follow the [privacy screening rules](AGENTS.md#privacy) before pushing or posting public text.
- Treat a privacy hit on pushed material as an exposure. Revoke and rotate exposed credentials immediately through the authorized owner. Escalate exposed personal data, customer data, hosts or internal names to the owner as a private blocker and propose a remedy. Leave any history rewrite or cache purge to the authorized incident response.

## Deviations

| Engineering standard rule | Reason for the deviation | Review date |
| --- | --- | --- |
| §1 Configurable environments and operational limits | The deploy workflow needs a configurable environment selector, and [apply-guard.cjs](scripts/deploy/apply-guard.cjs) needs a configurable DEV history window before the workflow can reuse the guard across environments. | 2026-12-15 |
| §§2, 6 Staging deployment and rollback rehearsal | Staging needs a deploy gate that can run a rollback rehearsal and retain its evidence. GO: Portfolio Lead 2026-11-22, review 2026-11-29. Accepted only while production stays paused; the production rollback command and a rehearsed staging rollback must exist before the first production deploy ([#200](https://github.com/MasarX/masarx-platform/issues/200)). | 2026-11-29 |
| §§2, 6 Production deployment and rollback | The production deploy gate, rollback command and audit recording still need implementation. GO: Portfolio Lead 2026-11-22, review 2026-11-29. Accepted only while production stays paused; the production rollback command and a rehearsed staging rollback must exist before the first production deploy ([#200](https://github.com/MasarX/masarx-platform/issues/200)). | 2026-11-29 |
| §2 Build and attest once on `main`, verify and record the same digest at each deployment | [Deploy DEV](.github/workflows/deploy.yml) still needs to consume, verify and record main-build artifacts. The separate [tag workflow](.github/workflows/provenance-on-tag.yml) supplies an attested archive for Landing only. | 2026-11-24 |
| §3 Zero required human approvals | The ruleset still needs to turn off `require_extra_approval_for_unattributed_changes: true`. | 2026-12-15 |
| §3 Annotated version and release-candidate tags | The [tag workflow](.github/workflows/provenance-on-tag.yml) needs checks for annotation and exact version syntax and a separate release-candidate path before it can treat the two tag types differently. | 2026-11-24 |
| §§2, 4 Full CI on pushes to `main` | [Public CI](.github/workflows/public-ci.yml) exercises the full graph on the queue's combined tree before merge. A full suite after merge would repeat that coverage. | 2026-12-15 |
| §4 PR feedback and full queue suite timing | The November first-attempt sample missed both PR targets and the merge-group p50 target. More speed work is needed beyond timing-weighted pgTAP shards. | 2026-12-15 |
| §4 CI timing measurement | [PR wall time](#checks) reports p50 and p90 from workflow start to `ci-gate` completion. Calculate p50 and p95 from first-attempt PR runs for the daily report and compare them with the PR feedback targets. The current timestamps leave waiting time, setup time and time to mergeable unreported. Collect job creation and start times for waiting, step timings for setup, and the last required check's completion time for time to mergeable. CodeQL is often the last check. | 2026-12-15 |
| §4 Job time limits based on a recorded p95 sample | Job limits still need recorded p95 samples and a monthly review. CodeQL cache maintenance also needs a job-level limit. | 2026-12-15 |
| §4 Sharding by measured file times | The [Unit Jest](.github/workflows/public-ci.yml) jobs need per-file timing data and a shard plan that uses it. | 2026-12-15 |
| §4 Test-file guard across suites | The pgTAP inventory covers SQL tests. Repository-wide coverage needs inventories for [Jest](config/tooling/jest.config.js) and the separately run browser suites. | 2026-12-15 |
| Code and design · Retries and red-test handling | Hosted database setup still retries [image pulls](scripts/ci-hosted/images.cjs). [Console V2 Playwright E2E](apps/console-v2/playwright.e2e.config.ts#L44-L66) retries on the local mock server, and [FieldOps Playwright E2E](tests/e2e/fieldops-mobile/playwright.config.ts#L29-L36) retries in CI mode. Qualify image setup without retries and use prebuilt app servers with readiness checks for those browser suites. The UI quarantine is empty, and `main` has no hosted Jest known-failure baseline. | 2026-12-15 |
| §4 Tests use local services and mocks only | These checks qualify deployed services on cloud test targets. [`npm run test:pgtap`](package.json#L13) can read `DATABASE_URL` from `.env.cloud` for [pgTAP](scripts/tests/run-pgtap-cloud.js#L5-L7). [`npm run verify:cloud:e2e-gate`](package.json#L27) checks [cloud endpoints](scripts/ops/assert-cloud-env.js#L243-L268) before running post-deploy E2E. | 2026-12-15 |
| §4 Local hooks and CI privacy enforcement on every push and merge group | Staged-file lint and formatting and the privacy screen still need shared hook wiring. Push and merge-group workflows need a privacy check job to enforce the screen in CI. | 2026-12-15 |
| §§1, 8 UI page budgets | [DESIGN.md](DESIGN.md#speed) supplies a time-to-usable method. The budget table still needs per-screen LCP and INP targets. | 2026-12-15 |
| Design principles · Required format checks | The required lint job and app-level format scripts cover different scopes. Add one lint and format path per language to the required CI job. | 2026-12-15 |
| Code and design · Deterministic tests and coverage reporting | Some browser checks still use fixed sleeps, and the unit-test configuration declares coverage thresholds. Replace sleeps with state-based waits and verify report-only coverage before changing enforcement. | 2026-12-15 |
| Environments · Environment names | GitHub calls the staging and production environments `stg` and `prod`. Their protected environment policies are configured under those identifiers. | 2026-12-15 |
| Branches, merging and releases · Branch lifecycle | GitHub deletes merged branches automatically. Delivery still needs first-push age reporting to enforce the PR deadline and a recorded process for stale branches without PRs. | 2026-12-04 |
