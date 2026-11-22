Follows engineering standard 2026-11-22 v1.2.

## Branching and merging

- The `main` queue permits one concurrent build. Use it without admission caps, drains or bypasses. Keep one migration item and one non-migration item in progress at a time.
- The manual merge hold is retired. The DEV apply guard (G1–G3) protects database applies.
- Apply the exact-head review to the risk paths in [AGENTS.md](AGENTS.md#risk-paths-need-one-independent-review-before-landing). GitHub can require an extra approval for unattributed changes.
- The tree-publisher App authors commits and pushes branches.
- Before enqueueing, verify the required checks and any applicable risk-path review for the exact PR head and the PR's issue reference (`Closes #n` or `Refs #n`). The App sets `expectedHeadOid` to the reviewed SHA. Keep auto-merge off. If the head moves or a review sends the PR back, disable auto-merge if set, dequeue it (`dequeuePullRequest`), and confirm no queue entry remains. Verify the queued head still matches the reviewed SHA.
- At push time, assign a fresh migration timestamp block above the newest migration on `main` and keep its files in landing order. A rename-only re-stamp needs no new review. Compare the pre-stamp and re-stamped commits. Verify every migration is `R100` in `git diff -M --name-status` and has zero content lines in `git diff -M --numstat`. Record the existing review against the resulting SHA. The append-only and ordering gate is in [migrations.cjs](scripts/ci-hosted/migrations.cjs).

## Checks

| Workflow | Work | Job limits (minutes) |
| --- | --- | --- |
| [CI](.github/workflows/public-ci.yml) | PR static checks and affected database, typecheck, Jest, UI, build and Landing E2E jobs. The base version of [changes.cjs](scripts/ci-hosted/changes.cjs) owns the shared inputs and fallback. [selfcheck.cjs](scripts/ci-hosted/selfcheck.cjs) checks its routing. The merge group runs the full hosted suite on the combined tree. Dependency review is PR-only. Manual dispatch can regenerate visual baselines. `ci-gate` aggregates the job results. | Database build and pgTAP 20 each, database result and append-only 5 each, lint/typecheck/unit/UI 20 each, Console and Portal/Landing builds 35 each, Landing E2E 30, visual baselines 60, dependency review and gate 5 each. |
| [CodeQL](.github/workflows/codeql.yml) | Scans JavaScript/TypeScript and Actions on PRs into `main`, queue groups and `main` pushes. The Monday schedule also prunes Actions caches. | Analysis 20. Cache pruning has a 5-minute step limit. |
| [Verify prebuilt](.github/workflows/verify-prebuilt.yml) | Checks the Console and Portal prebuilt packaging contract on matching PR paths. | 15. |
| [Deploy DEV](.github/workflows/deploy.yml) | Applies the database, deploys registered Edge Functions and deploys Console, Portal, Landing and ingress. Manual modes also support a database dry run and API schema diagnostics. | API schemas 10, database 180, dry run 90, Console and Portal 35 each, Landing 20, ingress 15, summary 5. |
| [Provenance on tag](.github/workflows/provenance-on-tag.yml) | Verifies the tagged commit and builds, attests and publishes the static Landing archive. | Verify 10, build and publish 20. |

- Use at most 20 jobs per CI run. The hosted browser suite covers Landing E2E. Full Console, Portal and FieldOps journeys need separate qualification.
- PR wall time uses the workflow start and the `ci-gate` result timestamps. Track p50 and p90 on the project board's CI-FAST item. Timing-weighted pgTAP shards were the first change ([#173](https://github.com/MasarX/masarx-platform/pull/173)).
- Keep queue-entry-to-completion wall time under 25 minutes. Track PR-open-to-merge time alongside PR wall time and queue wall time. Use a ±10% tolerance for timing comparisons unless the repository defines another tolerance.
- Use GitHub Actions job durations and counts for runner-minutes and job count. [hosted-usage-report.js](scripts/ops/ci/hosted-usage-report.js) summarizes runner usage exports. Gap: Standalone budgets for runner-minutes and time to merge are undefined.
- Measure product speed in a browser on production-class hardware against a written usable state. Before tuning a slow action, capture its request waterfall and client and server timings.

## Test policy

- Test every affected layer and land security tests with their code. Preserve product guards when fixing tests. Trunk tests can change only under a recorded exception decided by the Master. A replaced test keeps every assertion or records which design decision retired it.
- Hosted Jest ([jest.cjs](scripts/ci-hosted/jest.cjs)) reads the target-base known-failure baseline at `config/ci/known-failures.txt`. A missing baseline is empty. The file is absent on `main`. A candidate can retain or remove target-base entries.
- Only `npm run verify:cloud:e2e-gate` reads the [UI flake quarantine](config/ci/ui-flake-quarantine.json) for its cloud E2E summary outside hosted CI. Each entry carries an owner and expiry (`burn_down_by`).
- [database-result.cjs](scripts/ci-hosted/database-result.cjs) requires all six pgTAP shards and an exact count and name match against the SQL test inventory. [database-selfcheck.cjs](scripts/ci-hosted/database-selfcheck.cjs) probes missing and incorrect coverage.

## Environments

- `ci` runs per change and creates an isolated database with generated fixtures when the database lane runs.
- `dev` hosts the integration database and receives deployments on merges to `main`. Use generated fixtures for validation.
- `stg` is the GitHub environment for production-like qualification with approved test data. The deploy gate is pending.
- `prod` is configured for production data and approved releases. Production deployments are paused.
- Keep each environment's data separate. Use generated fixtures for tests.

## Releases

- The tag workflow verifies first-parent history on `main` and qualifying exact-SHA `ci-gate` evidence before building and attesting the static Landing archive. It publishes the archive and checksums to the GitHub Release with static artifact notes. The Delivery Lead updates those notes from the milestone's closed issues and then closes the milestone.
- GitHub's active `release-tags-create` and `release-tags-immutable` rulesets restrict tag creation and protect `v*` tags from updates and deletion.
- For a hotfix, cut from the deployed tag, test the fix, get the owner's explicit approval before a production deploy, and merge the deployed fix forward through the protected PR path.

## Deploys

- DEV deploys run from `main` only. The database job serializes applies in one concurrency group with cancellation disabled. Its configuration guard checks whether deployment is configured. The database merge gate is hosted from-zero replay plus pgTAP. Verify the DEV apply after every migration merge and retain the merged SHA, deploy result and applied migration evidence.
- The M6 DEV apply guards are active in [apply-guard.cjs](scripts/deploy/apply-guard.cjs) and the deploy workflow.
  - G1: Skip a superseded push when a newer deploy run targets the current tip of `main`. Refuse the apply if the replacing run ended without success or failure.
  - G2: Stop applies if the latest attempt in the 30-day history was unsuccessful, until `DEV_DB_REARMED_AT` is set to a valid timestamp later than that attempt's completion and no later than the current time. Treat a completed database job with missing step records as a possible apply attempt.
  - G3: Before a manual apply, require `expected_sha`, the run SHA and the current `main` tip to match.
  - G4: Once apply starts, write a sanitized apply summary on exit, including failure, and remove the temporary environment file and raw apply log.
- The routine DEV deploy audit row is the workflow run summary. It includes the G1–G3 guard decisions, the G4 apply summary and the final job's per-surface results table. Gate review and routine DEV and staging deployments follow the portfolio orchestration skill.
- Production automation and gate approval are pending. Require the owner's explicit yes and a verified production backup before every production deploy. Keep the previous version ready, check health after deploy and roll back immediately on failure.
- Gap: No production rollback command or staging/production deploy audit row is defined.

## Security

- The Delivery Lead acts on Dependabot, code scanning and secret scanning alerts from both default and generic patterns. Open an issue the same day for a new high or critical finding. [dependabot.yml](.github/dependabot.yml) configures weekly grouped npm and Actions updates.
- The local privacy deny check follows [AGENTS.md](AGENTS.md#privacy). It screens added content, paths, commit messages and identities, binary names and hashes, and PR text. Use it before pushing or opening or editing a PR. Proceed only on exit zero with a final line ending in `COMPLETE`.

## Deviations

| Engineering standard rule | Reason for the deviation | Review date |
| --- | --- | --- |
| §1 Configurable environments and operational limits | [apply-guard.cjs](scripts/deploy/apply-guard.cjs) sets the DEV history window in code. The deploy workflow selects a fixed `dev` environment. | 2026-12-15 |
| §§2, 6 Staging deployment and rollback rehearsal | The `stg` environment is configured. [Deploy DEV](.github/workflows/deploy.yml) supports DEV only, so the staging gate and rehearsal evidence are pending. | 2026-11-24 |
| §§2, 6 Production deployment and rollback | The `prod` environment is configured. Production automation, the deploy gate and the rollback command are pending. | 2026-11-29 |
| §2 Build and attest once on `main`, verify and record the same digest at each deployment | [Deploy DEV](.github/workflows/deploy.yml) builds from source inside its environment-specific jobs. [Provenance on tag](.github/workflows/provenance-on-tag.yml) builds and attests a separate static Landing archive. The deploy workflow does not verify an attestation or record a promoted digest. | 2026-11-24 |
| §3 Queue merge method | The active `main` ruleset uses `MERGE` with `ALLGREEN` and one concurrent build. | 2026-12-15 |
| §3 Zero required human approvals | The active ruleset requires zero approving reviews and disables code-owner review. Its extra approval option for unattributed changes is enabled. | 2026-12-15 |
| §3 Annotated version and release-candidate tags | [Provenance on tag](.github/workflows/provenance-on-tag.yml) accepts `v*`, dereferences to a commit and uses the same release path for all accepted tags. It does not enforce annotation, exact version syntax or a distinct release-candidate path. The live creation and immutability rulesets are active. | 2026-11-24 |
| §§2, 4 Full CI on pushes to `main` | [Public CI](.github/workflows/public-ci.yml) runs the full graph on merge groups and has no push trigger. The main push workflows are DEV deploy and CodeQL. | 2026-12-15 |
| §4 PR feedback and full queue suite timing | The November first-attempt sample missed the PR p50 and p95 targets and the merge-group p50 target. The project tracks PR wall time at p50/p90 and queue-entry wall time. Timing-weighted pgTAP was the first improvement. | 2026-12-15 |
| §4 Job time limits based on a recorded p95 sample | The workflows set the limits listed above. The CodeQL cache-maintenance job sets only a step timeout. Calibration samples and the monthly ratchet review are unverified. | 2026-12-15 |
| §4 Read-only top-level workflow permissions | [CodeQL](.github/workflows/codeql.yml) grants `security-events: write` at workflow scope. The other four workflows use top-level `contents: read`. | 2026-12-15 |
| §4 Sharding by measured file times | pgTAP uses recorded timings and verifies executed coverage. The two [Unit Jest](.github/workflows/public-ci.yml) shards use Jest's default sharding. | 2026-12-15 |
| §4 Test-file guard across suites | The enumerated execution guard covers pgTAP. The [integration Jest suite](config/tooling/jest.config.js) and the non-Landing browser suites have separate qualification commands. The hosted workflow has no inventory or allowlist gate covering every test file. | 2026-12-15 |
| §4 Retries and red-test handling | Hosted CI, prebuilt verification and DEV deployment retry dependency setup. The separate cloud E2E gate retries classified infrastructure failures and has a quarantine mechanism. Hosted Jest retains target-base known-failure handling even though `main` has no baseline. | 2026-12-15 |
| §4 Local hooks and CI privacy enforcement on every push and merge group | The local privacy screen is an explicit step. The repository has no configured pre-commit or pre-push hook and no privacy-deny producer in the hosted workflows. | 2026-12-15 |
| §§1, 8 UI page budgets | [DESIGN.md](DESIGN.md#speed) defines a time-to-usable method. Its per-screen budget table is still TBD and does not set LCP or INP budgets. | 2026-12-15 |
