# MasarX: rules for agents

## Project facts

- Repository: https://github.com/MasarX/masarx-platform · main branch: main
- Board (private): https://github.com/orgs/MasarX/projects/9 · Project brief: the board README
- Environments: `ci` and `dev` are active. `stg` and `prod` are configured. See [delivery environments](DELIVERY.md#environments).
- Release plan: [repository milestones](https://github.com/MasarX/masarx-platform/milestones).
- Leads (thread titles): "MasarX Master", "MasarX Delivery", "MasarX Design"
- UI project: yes
- Other repos: none
- Links: [DELIVERY.md](DELIVERY.md), [DESIGN.md](DESIGN.md), the portfolio engineering standard and the portfolio orchestration skill.

## Product and current goal

MasarX helps delivery teams manage shipments and coordinate integrations, warehouse activity, field execution and customer communication. The first staging release serves delivery operators, field teams and customers who need shipment status and delivery options. See `docs/product/mission.md` for the product mission.

## Architecture and single sources

- `apps/console-v2/` contains the operations console. `apps/console-v2/src/App.tsx` wires the router and app providers.
- `apps/console/` contains the Next.js console. `apps/console/app/layout.tsx` defines its root layout.
- `apps/portal/` contains the tenant portal. `apps/portal/app/layout.tsx` defines its root layout.
- `apps/fieldops/` contains the mobile field app. `apps/fieldops/App.tsx` defines its root.
- `apps/shared/` contains shared web app code. `apps/shared/app-layout.tsx` defines the shared layout.
- `supabase/migrations/` is the ordered SQL history for schema, database functions, grants and row-level security.
- `supabase/functions/` contains Edge Functions. `config/edge/functions.json` defines the function deployment inventory.
- `supabase/tests/pgtap/` contains database contract tests. `scripts/tests/run-pgtap-cloud.js` is the runner behind the root pgTAP script.
- `scripts/` contains tooling for setup, CI, testing and deployment. `scripts/ci-hosted/changes.cjs` defines hosted CI change selection.
- `tests/` contains application tests by suite. `config/ci/test-impact-map.json` defines test impact mapping.

## Commands

- Set up: use the Node.js version in `.nvmrc` and run `npm ci --ignore-scripts` at the repository root.
- Lint: `npm run lint:frontend`, `npm run lint:structure`, `npm run lint:commands`, `npm run lint:docs:ssot`, `npm run lint:db` and `npm run lint:db:managed-grants`. Select the checks that cover the change.
- Format Console V2: `npm --prefix apps/console-v2 run format`.
- Typecheck: `npm run typecheck:frontend`, `npm --prefix apps/console-v2 run typecheck`, or `npm run typecheck:fieldops`.
- Affected tests: run `npm run ci:local:impact -- --base-ref origin/main` against the intended base, substituting its ref when needed. The `ci` workflow in `.github/workflows/public-ci.yml` selects affected jobs for pull requests.
- Full tests: the same workflow runs the full hosted CI graph on `merge_group`. Use `npm run ci:local:strict` for strict local qualification. See `docs/guides/TESTING_GUIDE.md` for the suite commands and backend requirements.
- pgTAP: `npm run test:pgtap` uses `psql` and a configured, isolated PostgreSQL test database with the Supabase schema and fixtures. Verify the target before running database tests.
- Build: run `npm run build` in the Console, Console V2 or Portal app directory, or `npm run build:landing` at the root.
- Run locally: `npm run dev:console:v2`, `npm run dev:console`, `npm run dev:portal`, `npm run dev:fieldops` or `npm run dev:landing`. See `docs/guides/LOCAL_SETUP.md` for backend setup.

## Must-follow coding rules

- Definition of done: open an issue before fixing a finding, one issue per root cause. Every PR names its issue using `Closes #n` or `Refs #n`.
- Bulk-close issues by their content, never by title prefix. Have an independent reviewer spot-check a sample.
- Before adding anything, search the repository and the portfolio sources and board you can access. Prefer removing duplication or reusing existing code, built-ins or installed tools. Add an extension point when it has a second real consumer. Report duplicate implementations as bugs and consolidate them in their own PR. For additions, summarize what you searched and cite current primary documentation without exposing private sources.
- Read the affected code and callers before editing. Reproduce defects before fixing them. Keep one reviewable purpose per PR and update the affected docs with the behavior change. Cite checked evidence for results and preserve the original evidence when correcting a claim. File a dated bug for a temporary workaround.
- Keep each rule or value in one source. Read deployment and tenant differences and operator-tunable values from configuration. Store business rules as versioned, schema-validated records with actor, timestamp and change reason. Reject invalid records with the row identifier. Keep durable state in shared storage and keep modules focused, with clear names and comments that explain decisions.
- Validate inputs where data enters an API, import or configuration loader. Version contracts used by independent consumers and phase breaking changes across releases. Enforce authorization on the server, deny access by default and test each role. Paginate growing lists, avoid per-row queries and use query plans to justify indexes.
- Store instants in UTC and convert them to the user's time zone for display. Store future schedules as local time and an IANA time-zone name. Make jobs and inbound handlers safe to repeat by using deduplication keys. Set outbound call timeouts and a finite retry limit with backoff. Give users safe errors with a recovery action where available.
- Follow the [test policy](DELIVERY.md#test-policy) and [CI checks and runner rules](DELIVERY.md#checks).
- Follow [DESIGN.md](DESIGN.md) for UI changes. Use translation catalogs and cover Arabic, right-to-left layouts and WCAG 2.2 AA.
- The owner's approval is required only for production deployments, spending money or using paid services, access only the owner can grant, destructive operations on real data, and making private things public.

## Risk paths (need one independent review before landing)

- Apply the [risk-path review rule](DELIVERY.md#branching-and-merging) to changes on these paths.
- Safety and privacy rules: `AGENTS.md` and `DELIVERY.md`.
- Ownership and pipeline gates: `/CODEOWNERS`, `/.github/`, `/scripts/ci-hosted/`, `/config/ci/`, `/scripts/ops/ci/`, `/tooling/`.
- Database, Edge and deployment: `/supabase/migrations/`, `/supabase/config.toml`, `/config/edge/functions.json`, `/scripts/tests/run-pgtap-cloud.js`, `/scripts/deploy/` and production configuration.
- Environment and diagnostics: `/scripts/utils/load-env.js`, `/scripts/utils/env-file.js`, `/scripts/utils/pg-candidates.js`, `/scripts/utils/pg-hostaddr.js`, `/scripts/qa/qa-log.js`.
- Dependency and install controls: `**/package.json`, `**/package-lock.json`, `/deno.lock`, `**/npm-shrinkwrap.json`, `**/yarn.lock`, `**/pnpm-lock.yaml`, `**/pnpm-workspace.yaml`, `**/bun.lock*`, `**/.yarn/`, `**/.npmrc`, `**/.yarnrc*`, `**/.pnpmfile.*`, `**/.gitattributes`, `**/node_modules/`.
- Auth, permissions and privacy: `apps/console/app/auth/`, `apps/console/app/access-policy/`, `apps/portal/app/auth/`, `apps/portal/app/access-policy/`, `apps/console-v2/src/routes/auth/`, `apps/shared/security-middleware.ts`, `supabase/functions/` and SQL grants and row-level security.
- Data deletion and retention: purge functions and migrations, `scripts/ops/workspace/destroy.js` and `scripts/ops/workspace/delete-branch.js`.

## Data safety

Personal data handled by MasarX includes:

- Staff, tenant users and invitees, drivers, senders, recipients and customer contacts, including names, employee and contractor identifiers, account and role identifiers, memberships, phone numbers and email addresses.
- People who request a demo or apply for a tenant account, including names, email addresses, phone numbers, request and review notes, referral and campaign details, and IP hashes.
- Senders and recipients, including shipment contact details, pickup and delivery addresses and instructions, geocodes, shipment and label identifiers, tracking sessions and access history, return records, and delivery proof such as signatures, photos and recipient identity checks.
- Driver applicants and drivers undergoing verification, including government ID numbers (national ID or residence permit numbers), driving licence numbers and expiry dates, uploaded documents, and vehicle plates, identification numbers and registration documents.
- Third-party emergency contacts for drivers, including names and phone numbers.
- Driver health data, including medical certificates and pre-shift health declarations.
- Field incident reporters and affected people, including statements, photos, locations and severity for collisions, medical emergencies, theft or robbery, customer complaints, breakdowns and damage.
- Drivers and other operations staff, including qualifications, skills, shifts, hours of service, duty status, route and vehicle assignments, inspection and scan records, time-stamped location data, customer ratings, and performance and compliance events and scores.
- Customers, payees and account holders, including bank account and IBAN details and hashes, cash-on-delivery amounts and collections, and agreement, subscription, invoice, payment and settlement records.
- Support requesters and feedback respondents, including case details, attachments, message bodies, ratings, Net Promoter Scores (NPS) and free-text comments.
- People who access the service, including invitation, sign-in, password reset and session records, device and app identifiers, device verification records, push tokens, platform and version metadata, IP addresses and hashes, user agents, and audit records of user actions and changes.
- People who send or receive communications or whose records go through imports, integrations or workflows, including contact and delivery details, communication preferences and opt-outs, and personal data carried in messages, requests, responses and associated metadata.
- Marketplace applicants and participants, including legal and display names, contact details, memberships, document references and verification evidence, reviewer notes, offers and agreements, dispute titles, descriptions and resolutions, and ratings and reputation records.
- Contributors who publish or review automation assets, plan work or run tests, including account identifiers, assignments, submissions, review notes and evidence.

Keep real data in approved production databases, identity services, private object storage and protected backups. Limit any copies in approved integrations or on devices to what the feature needs. Restrict access by role and tenant. Use structured logs with request or trace IDs and identify people and records only by opaque IDs. Keep personal values, documents, payloads and tokens out of logs and fixtures. Generate consistent synthetic data for tests and examples.

Use the configured [location partition purge](supabase/migrations/202601251090_telemetry_partitioning_config_restore_v1.sql), [communications session and rate-limit cleanup](supabase/migrations/202512280020_cache_cleanup_worker_webhook_nonce.sql) and [operational record purge](supabase/migrations/20261114121100_database_lint_functions_v1.sql) for their respective records. [Public tracking sessions](supabase/migrations/202603061345_public_tracking_policy_and_service_v1.sql) use `expires_at` to end access. Expired rows remain stored. [Issue #295](https://github.com/MasarX/masarx-platform/issues/295) tracks the missing purge and the outstanding retention and deletion work for each personal-data category. Before using other personal data in production, document an approved retention period and verify deletion or anonymization from active stores, including attached objects. Include backup expiry and account for restored copies.

- Migrations are append-only. Never edit or delete a landed migration. Follow the [migration stamp and re-stamp rules](DELIVERY.md#branching-and-merging).
- Keep each release's database schema usable by the previous release's code. Ship drops, renames and narrowing changes only after an earlier release removes the code's use of the old schema shape.
- For a database function change, write a new migration with `CREATE OR REPLACE`. Start from the live catalog body using `pg_get_functiondef`, or the catalog after replaying `main` from zero. The original migration is historical. Preserve later fixes.
- Give new tables explicit `REVOKE` and `GRANT` statements and enable RLS with scoped policies. Give new functions explicit `REVOKE` and `GRANT` statements and verify their row access. State the effective grants for each new or changed function, such as `service_role` only.
- In migration PRs, list each `GRANT`, `REVOKE`, `ALTER DEFAULT PRIVILEGES` and `CREATE POLICY` by object, privilege or policy scope, and role. Reject broad schema grants, default-privilege changes, loop grants and changes to extension-managed privileges.
- Run `npm run lint:db:managed-grants` for changed migrations. Use the exact-file, hash-bound policy in `config/ci/supabase-managed-grants.json` for reviewed dynamic grant targets. Keep `supabase/tests/pgtap/045a_definer_execute_allowlist.sql` current when `SECURITY DEFINER` execute access for `anon` or `authenticated` changes in `public` or `api`.
- New public tables follow the executor-only trusted policy, API contract view and lookup contracts checked by `supabase/tests/pgtap/0zz_ui_rpc_executor_role_v1.sql`, `supabase/tests/pgtap/0zz_api_contract_views.sql` and `supabase/tests/pgtap/0zz_no_literal_enum_checks.sql`.
- Use an isolated test database and generated data. Never copy one environment's data into another. Require a [verified production backup before every production deploy](DELIVERY.md#deploys).

## Privacy

- Keep personal names, customer identifiers and images, real data, our hosts, IPs, internal machine, agent and tool names, private paths and instructions, project references, email addresses, account IDs and other account details, and credentials out of public material. Keep secrets out of chats, logs and source repositories. During research, use authorized read-only access and leave any credential you discover unused.
- Generate credential-shaped fixtures at runtime from synthetic values. Never commit literal credential-shaped fixtures. Keep environment files and real credentials out of version control.
- Verify that the commits you create use GitHub no-reply addresses for both author and committer. Keep attribution trailers, private names and private tooling details out of commit messages. Keep generated dependencies out of Git and verify licensing before adding third-party material. Check restored content line by line before it returns to the public tree.
- Before pushing, screen the exact candidate: each new commit's message and identities, paths, added content, binary names and hashes, and the branch name. Screen PR titles and bodies and issue or comment text before publishing or editing. Stop on a hit or push refusal and report the rule and affected path privately. Keep secret scanning and push protection enabled. Follow the [exposure response](DELIVERY.md#security).
- Gap: A pre-push hook and a required CI check are still pending.
