# Testing Guide

This guide explains how to run, interpret, and extend the test suites for the MasarX Delivery Platform.

The repo is cloud-first: most suites run against the Supabase cloud database using `ENV_FILE=config/env/.env.cloud`
(or an exported `DATABASE_URL`). Local runs are optional and should use the `local:*` commands.

Shell note:
- PowerShell: `$env:ENV_FILE = "config/env/.env.cloud"; <command>`
- bash/zsh: `ENV_FILE=config/env/.env.cloud <command>`

---

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
ENV_FILE=config/env/.env.cloud npm run test:pgtap
```

Covers (examples):
- Table/partition presence and invariants
- Required RLS enablement and policies (user-facing tables)
- Resolver/ladder expectations where applicable

---

### 3) Integration Tests (Jest, cloud DB)

Integration tests exercise workflow orchestration, settings/policies, webhook intake behavior,
and worker flows against the cloud database.

```bash
ENV_FILE=config/env/.env.cloud npm run test:integration -- --runInBand
```

Live external calls are guarded by env toggles (for example: `RUN_LIVE_*` flags).

---

### 4) Edge Smoke Tests (cloud)

Smoke tests hit deployed edge endpoints and validate end-to-end wiring
(secrets, auth, routing, basic RPC behavior).

```bash
ENV_FILE=config/env/.env.cloud npm run test:edge-smoke
```

---

### 5) Load Tests (k6)

The load runner uses Docker when available, and can fall back to a local Go toolchain
build for xk6 when Docker is unavailable.

```bash
ENV_FILE=config/env/.env.cloud npm run test:load -- --scenario=partition-performance
ENV_FILE=config/env/.env.cloud npm run test:load -- --scenario=webhook-ingest-http
```

Notes:
- Docker is preferred. When Docker is unavailable, the runner builds a local xk6 binary (requires Go) and executes the scenario with the same env-driven knobs.
- `partition-performance` cleans up inserted `LOAD-<run_id>-*` shipments by default during teardown. Set `PARTITION_CLEANUP=0` only when you explicitly want to preserve rows for debugging.
- Summaries are written under `tmp/` (for example `tmp/load-partition-performance-summary.json`).

---

### 6) Frontend UI/E2E (Console + Portal)

Frontend quality gates run with Jest UI tests and Playwright E2E:

```bash
npm run lint:frontend
npm run test:ui
npx playwright test --workers=1
```

Notes:
- UI tests rely on Testing Library `@testing-library/user-event` (declared in root devDependencies). If Jest cannot resolve it, run `npm install` from the repo root.
- Run Playwright locally without forcing `CI=1` when using localhost apps (`3001` console / `3002` portal), so the config can auto-start dev servers.
- In CI/strict environments, set `CONSOLE_BASE_URL` and `PORTAL_BASE_URL` explicitly.
- Use host-root values (for example `https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid`, `https://yguwjnwkkqutolgwughjsloj.example.invalid`), not `/console` or `/portal` path prefixes.
- If local app startup is slow, increase the Playwright web-server startup timeout with `E2E_WEB_SERVER_TIMEOUT_MS` (for example `E2E_WEB_SERVER_TIMEOUT_MS=600000`).
- Prefer `data-testid` selectors and resilient visibility checks for async/hydrating surfaces to avoid strict-locator flakes from duplicate hidden shells.

