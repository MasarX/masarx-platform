# MasarX: delivery

The Delivery Lead owns this file. Change it through a reviewed PR.

## Branching and merging

- `main` is the sole trunk. The queue uses `MERGE`, `ALLGREEN` grouping and one concurrent build. Require `ci-gate` and CodeQL at high-or-higher. Use the queue without admission caps, drains or bypasses.
- The manual merge hold is retired. The DEV apply guard (G1-G3) protects DEV database applies.
- Keep one migration item and one non-migration item in progress at a time.
- Risk paths in [AGENTS.md](AGENTS.md#risk-paths-need-one-independent-review-before-landing) require one independent full-diff review recorded against the exact head, plus green CI. There are no code-owner or lead approval lines: GitHub requires zero approving reviews for attributed PRs and code-owner review is off. GitHub can require an extra approval for unattributed changes.
- The tree-publisher App authors commits and pushes branches.
- Merging. The merge queue is the only path to merge. Queue entry needs green required PR checks, any applicable risk-path review and the PR's issue reference (`Closes #n` or `Refs #n`); no approval step is added. The App enqueues the PR with `expectedHeadOid` set to the reviewed SHA. Keep auto-merge off. If a PR's head moves or a review sends it back, disable auto-merge if set, dequeue the PR (`dequeuePullRequest`), and confirm no queue entry remains. Before relying on a queue entry, check that its head equals the reviewed SHA.
- At push time, assign a fresh migration timestamp block above the newest migration on `main` and keep its files in landing order. A rename-only re-stamp needs no new review. Compare the pre-stamp and re-stamped commits. Verify every migration is `R100` in `git diff -M --name-status` and has zero content lines in `git diff -M --numstat`. Record the existing review against the resulting SHA. The append-only and ordering gate is in `scripts/ci-hosted/migrations.cjs`.

## Checks

- On PRs, `.github/workflows/public-ci.yml` runs static checks and uses `scripts/ci-hosted/changes.cjs` from the base to select tests the diff can reach. The affected jobs cover database build and pgTAP, lint, typecheck, unit and UI tests, application builds and Landing E2E. Dependency review runs on PRs.
- Prove affected selection by deliberately hiding a representative change and verifying that the validation detects the missed coverage. `scripts/ci-hosted/selfcheck.cjs` checks the selector's routing.
- On `merge_group`, the same workflow runs the full hosted suite on the queue's combined tree. `ci-gate` aggregates the required jobs. Require a green result for the exact PR head and the queued combined tree. `.github/workflows/codeql.yml` scans PR and merge-group changes on `main`.
- Gap: Hosted browser tests cover Landing E2E. Full Console, Portal and FieldOps browser journeys need separate qualification, and visual baseline regeneration is manual.
- The CI budget is $0. Use free GitHub-hosted runners only and at most 20 jobs per run.

## Test policy

- Test every affected layer and land security tests with their code. Preserve product guards when fixing tests. Never edit trunk tests except under a recorded exception decided by the Master. A replaced test keeps every assertion or records which design decision retired each assertion.
- Fix failures at the cause. No retries, skips or widened timeouts. Never rerun an unchanged failure. New failures block.
- Hosted Jest reads the target-base known-failure baseline at `config/ci/known-failures.txt` using `scripts/ci-hosted/jest.cjs`. The runner treats a missing baseline as empty. The file is absent on `main`. A candidate can retain or remove target-base entries.
- Only `npm run verify:cloud:e2e-gate` reads `config/ci/ui-flake-quarantine.json` for its cloud E2E summary outside hosted CI. Its entries carry an owner and expiry (`burn_down_by`).
- `scripts/ci-hosted/database-result.cjs` requires all six pgTAP shards and an exact count and name match against the SQL test inventory. `scripts/ci-hosted/database-selfcheck.cjs` probes missing and incorrect coverage.

## Environments

- `ci`: temporary per change, on the runner, with an isolated database and generated fixtures when the database lane runs.
- `dev`: integration database and the target of the push deploy triggered by each merge to `main`. Use generated fixtures for validation.
- `stg`: configured GitHub environment for production-like release qualification with approved test data.
- `prod`: configured GitHub environment for production data and approved releases. Production deployments are paused.
- Keep each environment's data separate. Use generated fixtures for tests.

## Releases

- Plan releases as repository milestones. The Delivery Lead publishes the GitHub Release from the tag with notes drawn from the milestone's closed issues, then closes the milestone.
- Versioned `v*` tags are immutable. GitHub's `release-tags-create` and `release-tags-immutable` rulesets restrict tag creation and protect release tags from updates and deletion.
- `.github/workflows/provenance-on-tag.yml` verifies that the tagged commit is on the first-parent history of `main` and has qualifying `ci-gate` evidence. It builds the static Landing archive, attests its build provenance and attaches the artifact to the release.
- Gap: The tag workflow builds and attests the static Landing artifact. Exact-image promotion across staging and production remains to be established.
- Gap: The tag workflow currently creates the release with static artifact notes. Delivery updates the published notes from the milestone before closing it.

## Deploys

- DEV deploys run from main only. `.github/workflows/deploy.yml` runs in GitHub Actions and supports manual deployment and database dry runs.
- The database job serializes applies in one concurrency group with cancellation disabled. Its configuration guard checks that the deployment is configured. The database merge gate is hosted from-zero replay plus pgTAP. Verify the DEV apply after every migration merge and retain the merged SHA, deploy result and applied migration evidence.
- The M6 DEV apply guards are active in `scripts/deploy/apply-guard.cjs` and the deploy workflow.
  - G1: skip a superseded push when a newer deploy run targets the current tip of `main`. Refuse the apply if the replacing run ended without success or failure.
  - G2: stop applies if the latest attempt in the 30-day history was unsuccessful, until `DEV_DB_REARMED_AT` is set to a valid timestamp later than that attempt's completion and no later than the current time. Treat a completed database job with missing step records as a possible apply attempt.
  - G3: before a manual apply, require `expected_sha`, the run SHA and the current `main` tip to match.
  - G4: once apply starts, write a sanitized apply summary on exit, including failure, and remove the temporary environment file and raw apply log.
- Gap: The repository still needs production deploy automation. Production stays paused.
- Follow the [owner approval rules](AGENTS.md#must-follow-coding-rules) for release and deploy work. Require a verified production backup before every production deploy. Keep the previous version ready for rollback, check health after deploy and roll back immediately on failure.
- Releases through a checking gate are gated, not approved per change: the gate is reviewed once and gets one GO; after that, each change that passes it releases automatically with an audit row. A new kind of change needs a new GO.
- The audit row for each routine DEV deploy is the deploy workflow's run summary, which includes the apply guard's G1-G3 decisions, the G4 apply summary and the summary job's per-surface results table.
- Deploy-gate approval and routine dev/staging deploys follow the cross-project rule in the Portfolio brief.
- A production gate's GO is the owner's yes. No production gate is approved yet, so every production deploy needs the owner's explicit yes.

## Hotfixes

Cut from the deployed tag and test the fix. Get the owner's explicit approval before deploying a production hotfix. Merge the deployed fix forward through the protected PR path.

## Security

The Delivery Lead acts on Dependabot alerts, code scanning findings and secret scanning alerts from both default and generic patterns. `.github/dependabot.yml` configures dependency updates. Secret scanning and push protection are enabled. Open an issue the same day for a new high or critical finding.

## Speed and quality gates

- Measure before setting any limit. Use observed run and job timings.
- PR wall time: use the PR workflow start and `ci-gate` result timestamps in GitHub Actions. Track p50 and p90. Pipeline speed work and its measured results are tracked on the project board (CI-FAST item). The first lever, timing-weighted pgTAP shards, landed in #173.
- Queue wall time: use merge-queue entry and completion timestamps on the PR. Keep it under 25 minutes.
- Runner-minutes and job count: use GitHub Actions job durations and counts. The usage report in `scripts/ops/ci/hosted-usage-report.js` summarizes runner usage exports.
- Time to merge: use the PR open and merge timestamps. Track the end-to-end trend alongside PR wall and queue wall.
- Use a ±10% tolerance for timing comparisons unless the repository specifies another tolerance.
- Measure product speed in a browser on production-class hardware against a written usable state. Before tuning a slow action, capture its request waterfall and client and server timings.
- Gap: The repository leaves standalone numeric budgets for runner-minutes and time to merge unspecified.
