# Production release runbook

Production remains paused under [#152](https://github.com/MasarX/masarx-platform/issues/152). The database choice authorizes provisioning and the agreed cost. Each production apply requires separate explicit release approval from the owner. Run apply commands from a dedicated production checkout on the operator machine. Servers owns the private target configuration and reads credentials from mode `0600` files with shell tracing disabled.

## Supabase Pro setup

1. After the owner approves the cost, open the correct organization's Billing page in the owner's signed-in Chrome. Review the Pro estimate, compute for each active project, and any add-ons before confirming. The owner enters payment details. Verify that the organization shows Pro. [Supabase pricing](https://supabase.com/pricing)
2. In that same organization, create a separate, empty production project in the approved region and compute tier. Record its reference, URL, public API key and operator credentials in the private target configuration. Verify the production project reference differs from both DEV and staging. Keep production data out of both.
3. Servers populates the approved settings packet from the private target configuration. Use the existing variable names in [Deploy DEV](../../.github/workflows/deploy.yml) for the project reference, CORS, web projects and public client configuration. The operator's copies of database, provider and signing credentials stay on the operator machine. Keep production CORS scoped to the approved HTTPS origins. Confirm the guarded egress and Edge dispatch settings before applying or serving traffic. See [#211](https://github.com/MasarX/masarx-platform/issues/211).
4. Record automatic backup coverage and a current quarterly restore rehearsal in [DELIVERY.md](../../DELIVERY.md#deploys). A Supabase database backup covers database metadata for Storage. Back up the Storage objects separately and test their recovery. A new project may need to wait for its first completed daily backup. [Supabase backups](https://supabase.com/docs/guides/platform/backups)

## Tag and admit v0.2.0

Use the [v0.2.0 milestone](https://github.com/MasarX/masarx-platform/milestone/1) for the ship date and scope. A release candidate needs a successful staging deployment and a recorded rollback rehearsal before production admission. See [#243](https://github.com/MasarX/masarx-platform/issues/243) and [#200](https://github.com/MasarX/masarx-platform/issues/200).

Set `RELEASE_SHA` to the approved full commit SHA. Use a configured App helper path in `APP_RUN` for the GitHub read commands. Delivery creates the annotated tag using the authorized owner identity from [the release policy](../../DELIVERY.md#releases). Verify first-parent ancestry and the latest qualifying `ci-gate` before creating the tag.

```bash
set -euo pipefail
repo=MasarX/masarx-platform
tag=v0.2.0
app_gh=(python -I "$APP_RUN" --org MasarX --repo masarx-platform gh)
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]]
git fetch origin main
git rev-list --first-parent origin/main | grep -Fx "$RELEASE_SHA" > /dev/null
suites=$("${app_gh[@]}" api --paginate --slurp \
  "repos/$repo/actions/workflows/public-ci.yml/runs?head_sha=$RELEASE_SHA&per_page=100" |
  jq -c '[.[].workflow_runs[] | select((.event == "merge_group" and
    (.head_branch // "" | startswith("gh-readonly-queue/main/"))) or
    (.event == "push" and .head_branch == "main")) | .check_suite_id]')
"${app_gh[@]}" api --paginate --slurp \
  "repos/$repo/commits/$RELEASE_SHA/check-runs?check_name=ci-gate&filter=all&per_page=100" |
  jq -e --arg sha "$RELEASE_SHA" --argjson suites "$suites" '
    [.[].check_runs[] | select(.name == "ci-gate" and .head_sha == $sha and .app.slug == "github-actions") |
    select(.check_suite.id as $suite | $suites | index($suite))] | max_by(.id) |
    .status == "completed" and .conclusion == "success"' > /dev/null
git tag -a "$tag" "$RELEASE_SHA" -m "Release $tag"
git push origin "refs/tags/$tag"
tag_object=$("${app_gh[@]}" api "repos/$repo/git/ref/tags/$tag" |
  jq -er 'select(.object.type == "tag") | .object.sha')
"${app_gh[@]}" api "repos/$repo/git/tags/$tag_object" |
  jq -e --arg sha "$RELEASE_SHA" '.object.type == "commit" and .object.sha == $sha' > /dev/null
```

Run [Production preflight](../../.github/workflows/production-preflight.yml) at the annotated tag with that SHA. Record the run after the configured `prod` reviewer admits the preflight. The preflight records approval and source identity without creating a GitHub deployment or connecting to the database. Confirm the owner's explicit apply authorization separately.

```bash
"${app_gh[@]}" workflow run production-preflight.yml --repo "$repo" \
  --ref "$tag" -f "expected_sha=$RELEASE_SHA"
```

## Verify and promote the published artifacts

[Provenance on tag](../../.github/workflows/provenance-on-tag.yml) currently builds and attests only a static Landing release archive. [#285](https://github.com/MasarX/masarx-platform/issues/285) owns the main-build artifacts and deploy consumer. [#236](https://github.com/MasarX/masarx-platform/issues/236) owns the frozen Edge bundle and upload. Stop if any deployable lacks its attested main-build digest and matching staging evidence, or if the production deploy and rollback commands are unavailable. The tag-built Landing archive is release evidence for that archive.

For each deployable, take `ARTIFACT`, `ARTIFACT_SHA256` and `MAIN_BUILD_WORKFLOW` from the approved release record. Choose the workflow that produced the attestation, identified in `OWNER/REPO/.github/workflows/FILE` form. Verify the staged artifact before using the release's operator deploy entry point.

```bash
[[ "$ARTIFACT_SHA256" =~ ^[a-f0-9]{64}$ ]]
[[ "$(sha256sum < "$ARTIFACT" | cut -d ' ' -f 1)" == "$ARTIFACT_SHA256" ]]
"${app_gh[@]}" attestation verify "$ARTIFACT" --repo "$repo" \
  --signer-workflow "$MAIN_BUILD_WORKFLOW" --source-ref refs/heads/main \
  --source-digest "$RELEASE_SHA"
```

## Check the backup and apply

Before each production deployment, use the tagged checkout and the production project binding from Servers. `BACKUP_MAX_AGE_HOURS` is the approved maximum recovery-point age. The token on stdin needs Supabase Management API `backups_read` access to the selected project. The checker requires a fresh completed provider backup record. Retain its UTC timestamp with the release audit evidence and check the separately recorded restore rehearsal before continuing. [Backup listing API](https://supabase.com/docs/reference/api/v1-list-all-backups)

```bash
set +x
set -euo pipefail
git checkout --detach "$RELEASE_SHA"
export SUPABASE_PROJECT_REF BACKUP_MAX_AGE_HOURS
node scripts/deploy/check-supabase-backup.cjs < "$BACKUP_READ_TOKEN_FILE"
(
  export SUPABASE_ACCESS_TOKEN="$(< "$SUPABASE_ACCESS_TOKEN_FILE")"
  export SUPABASE_DB_PASSWORD="$(< "$SUPABASE_DB_PASSWORD_FILE")"
  "$SUPABASE_CLI" link --project-ref "$SUPABASE_PROJECT_REF" --yes
  "$SUPABASE_CLI" db push --linked --dry-run
)
```

`SUPABASE_CLI` is the checksum-verified version qualified with the release. Compare the dry-run migration list to the approved tagged migration plan. Once approved, run `db push` once through the same linked checkout. Keep the raw output in the operator's private release evidence.

```bash
node scripts/deploy/check-supabase-backup.cjs < "$BACKUP_READ_TOKEN_FILE"
(
  export SUPABASE_ACCESS_TOKEN="$(< "$SUPABASE_ACCESS_TOKEN_FILE")"
  export SUPABASE_DB_PASSWORD="$(< "$SUPABASE_DB_PASSWORD_FILE")"
  "$SUPABASE_CLI" link --project-ref "$SUPABASE_PROJECT_REF" --yes
  "$SUPABASE_CLI" db push --linked --yes
  "$SUPABASE_CLI" secrets set --project-ref "$SUPABASE_PROJECT_REF" --env-file "$EDGE_SECRET_FILE"
)
```

Recheck the production backup before promoting the verified Edge, ingress and web artifacts. For Edge and ingress, use the exact verified bundle upload commands recorded by the staging rehearsal. For web, extract the verified artifacts using the release manifest. Each Vercel directory must contain the production `.vercel/output` layout. Set the project selectors from Servers, pointing CLI credentials at the correct account, and disable CLI telemetry on the operator machine.

```bash
node scripts/deploy/check-supabase-backup.cjs < "$BACKUP_READ_TOKEN_FILE"
export VERCEL_ORG_ID VERCEL_TELEMETRY_DISABLED=1 CLOUDFLARE_ACCOUNT_ID
(
  export VERCEL_TOKEN="$(< "$VERCEL_TOKEN_FILE")"
  cd "$CONSOLE_PREBUILT_DIR"
  VERCEL_PROJECT_ID="$VERCEL_PROJECT_ID_CONSOLE" "$VERCEL_CLI" deploy --prebuilt --prod --yes
  cd "$PORTAL_PREBUILT_DIR"
  VERCEL_PROJECT_ID="$VERCEL_PROJECT_ID_PORTAL" "$VERCEL_CLI" deploy --prebuilt --prod --yes
)
(
  export CLOUDFLARE_API_TOKEN="$(< "$CLOUDFLARE_API_TOKEN_FILE")"
  "$WRANGLER_CLI" pages deploy "$LANDING_PREBUILT_DIR" \
    --project-name "$CLOUDFLARE_PAGES_PROJECT_LANDING" --branch "$LANDING_PRODUCTION_BRANCH"
)
```

Assert the target projects before each upload. Record the actual digests, migration result, approvals, health checks and rollback reference. If a release health check fails, stop further promotion and use the rehearsed rollback. The first production release stays paused until the operator entry point and its staging proof exist.

For staging qualification, run the same backup checker with only the staging reference and a staging-scoped `backups_read` token. Use a generated dataset and a completed backup in the approved staging recovery window. Rehearse the restore in an isolated staging target and retain the proof. A staging tier without managed backups needs a test target with that feature before the live API check can pass.

## Operator-managed Supabase estimate

Budget **5–8 engineering days** for a first staging-qualified deployment and **2–4 hours per month** for patching, monitoring and backup review, plus incident response and quarterly restore exercises. Estimate **$55–$120/month** for one 8–16 GB server and off-host backups before tax, high egress, labor or a standby. The range uses published 4-vCPU, 8 GB and larger VM rates and reserves a small backup/storage allowance. Supabase recommends starting at 4 CPU cores, 8 GB RAM and 80 GB SSD for the full stack. [Supabase requirements](https://supabase.com/docs/guides/self-hosting/docker) · [VM rates](https://www.digitalocean.com/pricing/droplets) · [Backup storage rates](https://www.backblaze.com/cloud-storage/pricing)

Replace the managed setup and backup sections with provisioning of pinned Supabase services, TLS and firewall configuration, operator-managed Auth, database and Edge secrets, off-host database and object backups, and a restore rehearsal. Replace managed CLI linking, backup listing and Edge upload with the operator's migration connection, backup inventory check and pinned Edge Runtime bundle rollout. Keep exact-digest web promotion, health verification and rollback approval. Budget for Auth, Storage, `pg_net`, cron and Vault compatibility checks. A single server has a single-node outage risk. Servers owns patching, key rotation, backup retention and recovery.
