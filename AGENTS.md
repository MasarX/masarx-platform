# MasarX: rules for agents

## Project facts

- Repository: https://github.com/MasarX/masarx-platform · main branch: main
- Board (private): https://github.com/orgs/MasarX/projects/9 · Project brief: the board README
- Environments: `ci` and `dev` are active. `stg` and `prod` are configured. See [delivery environments](DELIVERY.md#environments).
- Release plan: [repository milestones](https://github.com/MasarX/masarx-platform/milestones).
- Leads (thread titles): "MasarX Master", "MasarX Delivery", "MasarX QA", "MasarX Design"
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

Push and let CI run tests, lint, typecheck and builds. Do not run them locally on the shared workstation.

- Set up: use the Node.js version in `.nvmrc` and run `npm ci --ignore-scripts` at the repository root.
- Lint command references: `npm run lint:frontend`, `npm run lint:structure`, `npm run lint:commands`, `npm run lint:docs:ssot`, `npm run lint:db` and `npm run lint:db:managed-grants`.
- Format Console V2: `npm --prefix apps/console-v2 run format`.
- Typecheck command references: `npm run typecheck:frontend`, `npm --prefix apps/console-v2 run typecheck`, or `npm run typecheck:fieldops`.
- Affected tests: after a push to a pull request, the [CI workflow](.github/workflows/public-ci.yml) selects affected jobs and `ci-gate` checks their results. Command reference: `npm run ci:local:impact -- --base-ref origin/main`.
- Full tests: the same workflow runs the full hosted CI graph on `merge_group`, with `ci-gate` aggregating the results. Command reference: `npm run ci:local:strict`. See the [testing guide](docs/guides/TESTING_GUIDE.md) for suite commands and backend requirements.
- pgTAP: the `Database pgTAP` matrix runs all six shards when CI selects database coverage on a pull request and on every `merge_group`. Command reference: `npm run test:pgtap`, which uses `psql` and requires a verified, isolated PostgreSQL test database with the Supabase schema and fixtures.
- Build command references: `npm run build` in the Console, Console V2 or Portal app directory and `npm run build:landing` at the root.
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
- Apply the [critical-change review rule](#critical-changes-the-only-changes-that-get-a-review) when preparing a PR.
- Follow [DESIGN.md](DESIGN.md) for UI changes. Use translation catalogs and cover Arabic, right-to-left layouts and WCAG 2.2 AA.
- The owner's approval is required only for production deployments, spending money or using paid services, access only the owner can grant, destructive operations on real data, and making private things public.

## Critical changes (the only changes that get a review)

The owner's rule (24 Nov): critical means production, secrets, real data, making anything public, host/network/firewall changes, repo settings and release gates.

- Production: production configuration and deploys, `/scripts/deploy/`, `/supabase/config.toml` and `/config/edge/functions.json`.
- Secrets: how they are stored, read, scoped or rotated, and token helpers. This includes `/scripts/utils/load-env.js`, `/scripts/utils/env-file.js` and `/scripts/qa/qa-log.js`.
- Real data:
  - every migration in `/supabase/migrations/`;
  - deletes, purges, retention, audit logs and history, backups and restores, including `scripts/ops/workspace/destroy.js` and `scripts/ops/workspace/delete-branch.js`;
  - the database-target selection in `/scripts/utils/pg-candidates.js` and `/scripts/utils/pg-hostaddr.js`;
  - sign-in, permissions, and server code that decides which real data people can access or what personal data an API returns. This includes SQL grants, row-level security, server code in `/supabase/functions/`, `SECURITY DEFINER` function bodies, API contract views, `apps/shared/security-middleware.ts`, the server routes in `apps/console/app/api/` and `apps/portal/app/api/`, and the Console, Console V2 and Portal sign-in and access-policy paths. It also covers personal data carried in exports, prints and outbound messages.
  - safety-critical rules until end-to-end tests cover every project safety rule. Each new safety rule requires review until its end-to-end test lands. [Issue #558](https://github.com/MasarX/masarx-platform/issues/558) tracks the rule and test inventory.
- Making anything public: repository, package or bucket visibility, and new public endpoints.
- Host, network and firewall: public ingress routes, CORS, token rules and rewrites in `tooling/apps/api-ingress-worker/`, the egress proxy and its allowlists, servers, DNS and firewall rules. Egress controls include `supabase/functions/api-caller/egress.mjs`, `supabase/functions/api-caller/proxy.mjs`, `supabase/migrations/20261123046800_validate_outbound_integration_urls.sql` and `scripts/ops/verify-api-caller-guarded-egress-proxy.js`.
- Repo settings and release gates: rulesets and repository settings, the privacy deny check, `/CODEOWNERS`, `/.github/`, `/scripts/ci-hosted/`, `/config/ci/` (including the quarantine and accepted-failure lists), `/scripts/ops/ci/`, `/scripts/tests/run-pgtap-cloud.js`, and scripts CI or deploy workflows run directly or through `package.json` script entries. This includes `scripts/edge/verify-frozen-lock.cjs`, `scripts/edge/verify-npm-import-lock.js` and `scripts/ops/vercel/validate-build.js`. Deleting, skipping or weakening a test, including pgTAP authorization and contract tests, or changing the test-file guard allowlist is critical.

Documentation changes that alter a manual or automated merge or deploy gate, or who must review or approve a change, are critical.

**Not critical on their own.** Dependencies and lockfiles, internal tools under `/tooling/` outside the public ingress worker, money rules, and added or changed tests that preserve existing checks. Spending money still requires the owner's approval.

Follow the [review and merge process](DELIVERY.md#branching-and-merging).

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
- After a push with migration changes to a pull request, the CI `Lint` job runs `npm run lint:db:managed-grants`. Use the exact-file, hash-bound policy in `config/ci/supabase-managed-grants.json` for reviewed dynamic grant targets. Keep `supabase/tests/pgtap/045a_definer_execute_allowlist.sql` current when `SECURITY DEFINER` execute access for `anon` or `authenticated` changes in `public` or `api`.
- New public tables follow the executor-only trusted policy, API contract view and lookup contracts checked by `supabase/tests/pgtap/0zz_ui_rpc_executor_role_v1.sql`, `supabase/tests/pgtap/0zz_api_contract_views.sql` and `supabase/tests/pgtap/0zz_no_literal_enum_checks.sql`.
- Use an isolated test database and generated data. Never copy one environment's data into another. Require a [verified production backup before every production deploy](DELIVERY.md#deploys).

## Privacy

- Keep personal names, customer identifiers and images, real data, our hosts, IPs, internal machine, agent and tool names, private paths and instructions, project references, email addresses, account IDs and other account details, and credentials out of public material. Values the product deliberately sends to every browser are public: each environment's Supabase project URL and reference, its anon key, and its public site and form addresses. Hosts, project references and account IDs that browsers do not receive, including hosting and Cloudflare account IDs, stay private. Keep secrets out of chats, logs and source repositories. During research, use authorized read-only access and leave any credential you discover unused.
- Generate credential-shaped fixtures at runtime from synthetic values. Never commit literal credential-shaped fixtures. Keep environment files and real credentials out of version control.
- Verify that the commits you create use GitHub no-reply addresses for both author and committer. Commit authors, committers and trailers name only bots, AI tools or the project's public identity, each with a no-reply address, never a real person's name or personal email. Keep private names and private tooling details out of commit message text. Keep generated dependencies out of Git and verify licensing before adding third-party material. Check restored content line by line before it returns to the public tree.
- Before pushing, screen the exact candidate: each new commit's message and identities, paths, added content, binary names and hashes, and the branch name. Screen PR titles and bodies and issue or comment text before publishing or editing. Stop on a hit or push refusal and report the rule and affected path privately. Keep secret scanning and push protection enabled. Follow the [exposure response](DELIVERY.md#security).
- Gap: A pre-push hook and a required CI check are still pending.
