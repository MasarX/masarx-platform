# Testing Guide

This guide explains how to run, interpret, and extend the test suites for the MasarX Delivery Platform.

The repo is cloud-first: most suites run against the Supabase cloud database using `ENV_FILE=path/to/cloud-config` Replace the sample path with the path to your private cloud configuration file.
(or an exported `DATABASE_URL`). Local runs are optional and should use the `local:*` commands.

Shell note:
- PowerShell: `$env:ENV_FILE = "path/to/cloud-config"; <command>`
- bash/zsh: `ENV_FILE=path/to/cloud-config <command>`

---

## Match verification to the change

Use focused unit tests for code that has no runtime dependency. Use pgTAP for migration, permission and row-level security contracts. Use integration tests to verify the persisted effects of an application or edge request against an isolated database. Run deployment and load checks against an authorized test environment with generated fixtures.

For intake changes, cover request authentication, acknowledgment behavior, duplicate requests and the redaction of persisted headers and query values. For shipment changes, check the resulting row, workflow status and audit records under the applicable tenant scope. Compare the observed settings and workflow decisions with the scope that was expected to win.

When adding a fixture, generate identifiers at setup and reuse them across requests and assertions. Keep SQL-only tests transactional and explicitly clean up rows created through the API.

## Hosted suite coverage

The required CI lint job inventories tracked test files, runner configurations and
npm test commands. It compares the inventory with files selected by the hosted
runners, the post-DEV browser report and the
[suite quarantine](../../config/ci/test-suite-quarantine.json). The inventory step
uses the runners' file-listing mode.

Console V2 seed mode uses the app's fallback fonts so browser tests can run with
external requests blocked.

Wire new suites into an existing CI job where their dependencies are available.
For a suite that needs unavailable infrastructure, record its scope, owning lead,
reason, tracking issue and last active UTC date in the quarantine. CI fails on
uncovered entries, expired quarantines and selectors that no longer cover a suite.

## Test Suites

### 1) Unit Tests (no DB)

Fast, isolated checks for Node modules and tooling.

```bash
npm run test:unit
```

Use this when editing scripts, plan tooling, or small helpers.

---

### 2) pgTAP (schema + RLS verification)

Schema validation runs against the cloud database using `psql` (the runner streams and stops
on first failure).

```bash
ENV_FILE=path/to/cloud-config npm run test:pgtap
```

Covers (examples):
- Table/partition presence and invariants
- Required RLS enablement and policies (user-facing tables)
- Resolver/ladder expectations where applicable

Hosted CI replays migrations from zero and checks `PUBLIC EXECUTE` in the Data API schema (`api`) and its application support schema (`public`). Internal schemas such as `workflow_handlers` have separate caller contracts and require their own catalog review before this guard can cover them. Revoke `EXECUTE` from `PUBLIC` and any unintended roles by exact signature when creating a function, then grant it only to intended callers. [Hosted function privilege guard](../../supabase/tests/pgtap/045b_public_function_execute.sql)

---

### 3) Integration Tests (Jest, cloud DB)

Integration tests exercise workflow orchestration, settings/policies, webhook intake behavior,
and worker flows against the cloud database.

```bash
ENV_FILE=path/to/cloud-config npm run test:integration -- --runInBand
```

Live external calls are guarded by env toggles (for example: `RUN_LIVE_*` flags).
The cloud integration runner keeps caller-provided `RUN_*` values when loading an environment file, including in override mode. Its child processes inherit the resolved environment.

The RLS and Data API boundary tests run whenever Jest selects their files. Use an isolated backend.
RLS tests require `DATABASE_URL`. Data API boundary tests require `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
Missing settings fail the affected suite. The hosted integration shards supply these settings from their disposable Supabase stack.

---

### 4) Edge Smoke Tests (cloud)

Run [Verify DEV Edge startup](../../.github/workflows/dev-edge-startup.yml) on `main` after its push deployment succeeds. The job records the frozen upload run, attempt, job and commit, then checks the expected response and a Supabase runtime execution marker for every enabled DEV Edge function. It uses only `OPTIONS` with the DEV anon JWT where gateway verification requires it. These checks exercise startup and the handler's initial response. The label renderer deploy probe and the cloud smoke suite below exercise application behavior.

Smoke tests hit deployed edge endpoints and validate end-to-end wiring
(secrets, auth, routing, basic RPC behavior).

```bash
ENV_FILE=path/to/cloud-config npm run test:edge-smoke
```

---

### 5) Load Tests (k6)

The load runner uses Docker when available, and can fall back to a local Go toolchain
build for xk6 when Docker is unavailable.

```bash
ENV_FILE=path/to/cloud-config npm run test:load -- --scenario=partition-performance
ENV_FILE=path/to/cloud-config npm run test:load -- --scenario=webhook-ingest-http
```

Notes:
- Docker is preferred. When Docker is unavailable, the runner builds a local xk6 binary (requires Go) and executes the scenario with the same env-driven knobs.
- `partition-performance` cleans up inserted `LOAD-<run_id>-*` shipments by default during teardown. Set `PARTITION_CLEANUP=0` only when you explicitly want to preserve rows for debugging.
- Summaries are written under `tmp/` (for example `tmp/load-partition-performance-summary.json`).

---

### 6) Frontend UI/E2E (Console + Portal)

Frontend quality gates run with Jest UI tests and Playwright E2E.

```bash
npm run lint:frontend
npm run test:ui
npm run test:e2e -- --workers=1
npm run test:e2e:landing
```

#### UI component tests

The UI Jest suite uses jsdom, Testing Library, and `ts-jest` with `tsconfig.jest.json`. Its setup adds `jest-dom` and `jest-axe` matchers and supplies missing browser APIs such as `TextEncoder`, `TextDecoder`, `ResizeObserver`, and `matchMedia`. [Jest UI config](../../config/tooling/jest.config.ui.js) · [UI setup](../../tests/ui/setup.ts)

Use `renderWithIntl()` for components that need translations, React Query, or toasts. It wraps Testing Library's `render()` with `NextIntlClientProvider`, `QueryProvider`, and `ToastHost`, and defaults to the merged English UI and Console messages. [Render helper](../../tests/ui/test-utils.tsx)

Jest maps `next/cache`, `next-intl`, `server-only`, and stylesheet imports to module mocks. For component-specific dependencies, mock `next/navigation`, `next/link`, or the relevant `@masarx/api` entry point in the test. [Module mocks](../../tests/ui/__mocks__/)

#### Next.js Console and Portal E2E

The root Playwright config matches specs in `tests/e2e/` by project.

| Project | Spec filename prefix | Local app |
| --- | --- | --- |
| `console` | `console` | Console, port `3001` |
| `a11y` | `a11y` | Console, port `3001` |
| `shared` | `action`, `logging`, `navigation`, `labels` | Console, port `3001` |
| `portal` | `portal` | Portal, port `3002` |

The suite uses zero retries and retains traces, screenshots, and video on failure. The root config defines the timeout defaults, worker defaults, and exact filename patterns. [Playwright config](../../playwright.config.ts)

- Use `E2E_PROJECTS` to select projects. In strict runs (`CI`, `STRICT_E2E_GATE_ENV`, or `E2E_REQUIRE_BASE_URLS`), set an explicit non-loopback, host-root `CONSOLE_BASE_URL` for the `console`, `a11y`, or `shared` projects and `PORTAL_BASE_URL` for the `portal` project.
- For local runs, the root config starts `dev:console:legacy` and `dev:portal` for selected apps at their default local origins. To start the Next.js console manually, run `npm run dev:console`. Match the configured origin to the host and port where the app is serving.
- To test a built Next.js app locally, use its `build` and `start` scripts and point Playwright at that server's origin.
- For a manually started Next.js dev server, add the browser hostname to `NEXT_ALLOWED_DEV_ORIGINS` in the selected environment. Playwright supplies it automatically to the dev servers it starts. [Origin resolution](../../apps/shared/next-dev-origins.js)
- `E2E_WORKERS` sets the worker count. `E2E_WEB_SERVER_TIMEOUT_MS`, `E2E_TEST_TIMEOUT_MS`, and `E2E_EXPECT_TIMEOUT_MS` configure the startup, test, and assertion timeouts. `E2E_FORCE_CLEAN` replaces existing local app listeners and clears their Next.js caches before startup.

Use the [E2E utilities](../../tests/e2e/utils/) for sign-in and sessions (`auth.ts`, `session.ts`), test accounts (`demo-accounts.ts`), origins and route prefixes (`base-urls.ts`, `base-paths.ts`), navigation and route coverage (`navigation.ts`, `coverage-routes.ts`), performance assertions (`performance.ts`), and runtime error checks (`error-guards.ts`, `runtime-errors.ts`).

After the asserted route is ready, call `captureRouteEvidence(page, assertedLocator, { role, route, ledgerState })` from [evidence.ts](../../tests/e2e/utils/evidence.ts). Pass `rows` or `empty` for the pickup waves and requests ledgers and omit the field for Dashboard and Dispatch.
Tag identity and record fields with `data-evidence-mask`. The helper requires `context-identity` on every route, `dashboard-identity` on Dashboard and `record-id` for populated pickup ledgers. It attaches a masked viewport PNG as `route-evidence-image` and its JSON entry as `route-evidence-record`.
Use a sweep configuration with automatic screenshots, traces and video disabled.

#### Landing E2E

The `landing` project covers `tests/landing-e2e/`. By default it uses one worker and starts `dev:landing` locally with a preferred port of `3333`. Use `LANDING_BASE_URL` to select an existing environment or `LANDING_E2E_PORT` to set the preferred local port. `LANDING_E2E_WORKERS` accepts integers from `1` through `4`. [Landing Playwright config](../../playwright.landing.config.ts)

The hosted browser job uses dedicated loopback configurations for [synthetic Landing E2E](../../scripts/ci-hosted/playwright.landing.config.cjs) and [Console V2 seed-mode axe](../../scripts/ci-hosted/playwright.console-a11y.config.cjs). Qualify full Next.js Console and Portal E2E separately with the origins above.

#### Console V2 readiness

- For a local Console V2 server, use `npm run dev:console:v2 -- --port <leased-port>`. [Local setup](LOCAL_SETUP.md)
- For Console V2 production-readiness checks, navigate to each target through visible app controls first: sidebar/shell navigation, command palette, breadcrumbs, row actions, drawer actions, or other in-app links. Direct URL entry is a separate deep-link/legacy-redirect assertion and cannot be the only proof that the route is navigable.
- Treat pgTAP as necessary but not sufficient for Console V2 readiness. Each production-readiness slice also needs frontend route/action tests, Browser-click proof from the operator shell, at least one unbiased frontend lifecycle auditor, and an evidence table covering frontend surface, backend/API/RPC wiring, CRUD/action coverage, Browser status, automated tests, gaps, fixes, and final verdict.
- Treat Playwright as supporting evidence only for Console V2/Landing readiness. Completion requires Browser/Chrome click proof on a backend-backed runtime (`VITE_USE_SEED=false` with live Supabase credentials or approved cloud/preview/stg), with real API/RPC/data proof and no seed/demo/mock/synthetic rows, in-memory adapters, or toast-only success.
- Run `npm --prefix apps/console-v2 run test:e2e:console` for seed smoke. It excludes `@live-readiness`. Run `npm --prefix apps/console-v2 run test:e2e:console:live` with `E2E_CONSOLE_LIVE=1`, `VITE_USE_SEED=false`, live Supabase environment values, and observed Supabase RPC traffic for readiness proof. [Console V2 Playwright config](../../apps/console-v2/playwright.e2e.config.ts)

#### Writing new tests

- Put focused unit tests in `tests/unit/<area>/` with a `.test.js`, `.test.ts`, or `.test.tsx` suffix.
- Put UI component tests in `tests/ui/` with a `.test.ts` or `.test.tsx` suffix. Use `renderWithIntl()` and mock routing or API dependencies where the component needs them.
- Put Console and Portal E2E specs in `tests/e2e/`. Use the project prefix and the `.spec.ts` suffix, for example `console-settings.spec.ts`. Reuse the auth and navigation helpers. Use stable selectors such as `data-testid` and visibility assertions for async surfaces.

