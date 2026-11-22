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
- Follow the [test policy](DELIVERY.md#test-policy) and [CI checks and runner rules](DELIVERY.md#checks).
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

- Migrations are append-only. Never edit or delete a landed migration. Follow the [migration stamp and re-stamp rules](DELIVERY.md#branching-and-merging).
- For a database function change, write a new migration with `CREATE OR REPLACE`. Start from the live catalog body using `pg_get_functiondef`, or the catalog after replaying `main` from zero. The original migration is historical. Preserve later fixes.
- Give new tables explicit `REVOKE` and `GRANT` statements and enable RLS with scoped policies. Give new functions explicit `REVOKE` and `GRANT` statements and verify their row access. State the effective grants for each new or changed function, such as `service_role` only.
- In migration PRs, list each `GRANT`, `REVOKE`, `ALTER DEFAULT PRIVILEGES` and `CREATE POLICY` by object, privilege or policy scope, and role. Reject broad schema grants, default-privilege changes, loop grants and changes to extension-managed privileges.
- Run `npm run lint:db:managed-grants` for changed migrations. Use the exact-file, hash-bound policy in `config/ci/supabase-managed-grants.json` for reviewed dynamic grant targets. Keep `supabase/tests/pgtap/045a_definer_execute_allowlist.sql` current when `SECURITY DEFINER` execute access for `anon` or `authenticated` changes in `public` or `api`.
- New public tables follow the executor-only trusted policy, API contract view and lookup contracts checked by `supabase/tests/pgtap/0zz_ui_rpc_executor_role_v1.sql`, `supabase/tests/pgtap/0zz_api_contract_views.sql` and `supabase/tests/pgtap/0zz_no_literal_enum_checks.sql`.
- Use an isolated test database and generated data. Never copy one environment's data into another. Require a [verified production backup before every production deploy](DELIVERY.md#deploys).

## Privacy

- Keep personal names, customer identifiers, real data, hosts, IPs, private paths, project references, email addresses, account IDs and secrets out of public text, code, fixtures, logs, commits, issues and pull requests.
- Generate credential-shaped fixtures at runtime from synthetic values. Never commit literal credential-shaped fixtures. Keep environment files and real credentials out of version control.
- Before pushing, screen the exact candidate diff, commit messages and identities for secrets, names and hosts. Screen PR, issue and comment text before posting or editing it. Include the PR title, body and branch when screening a PR. Stop on any finding.
- GitHub secret scanning and push protection are enabled. Never weaken either control.
- Gap: A pre-push hook and a required CI check are still pending.
