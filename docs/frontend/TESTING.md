# Frontend Testing Guide

## Test Suites Overview

| Suite | Runner | Environment | Directory | Config |
|-------|--------|-------------|-----------|--------|
| Unit | Jest | Node | `tests/unit/` | `config/tooling/jest.config.unit.js` |
| UI Component | Jest + React Testing Library | jsdom | `tests/ui/` | `config/tooling/jest.config.ui.js` |
| E2E | Playwright | Chromium | `tests/e2e/` | `playwright.config.ts` |
| Landing E2E | Playwright | Chromium | `tests/landing-e2e/` | `playwright.landing.config.ts` |

## Running Tests

```bash
# Unit tests (Node environment, serial execution)
npm run test:unit

# UI component tests (jsdom, serial execution)
npm run test:ui

# E2E tests (starts console on :3001 and portal on :3002 locally)
npm run test:e2e

# Landing page E2E tests (starts landing on :3333 locally)
npm run test:e2e:landing
```

Both Jest suites run with `--runInBand` (serial) to avoid jsdom/Node isolation issues.

## Unit Tests

- **Environment:** Node (no DOM)
- **Scope:** Scripts and config utilities (`scripts/`, `config/`)
- **TypeScript:** Compiled via `ts-jest` with `tsconfig.jest.unit.json`
- **Coverage:** Per-file thresholds (e.g. `scripts/utils/load-env.js` at 60% lines). Global threshold set to 0 while coverage expands.
- **Custom reporter:** `config/tooling/jest.qa.reporter.js`

## UI Component Tests

- **Environment:** jsdom
- **Scope:** React component rendering, interactions, and accessibility
- **TypeScript:** Compiled via `ts-jest` with `tsconfig.jest.json` (extends `tsconfig.base.json`, CommonJS module, `react-jsx`)

### Setup (`tests/ui/setup.ts`)

The setup file runs before each test suite and:

1. Imports `@testing-library/jest-dom` for DOM matchers (`toBeInTheDocument`, etc.)
2. Extends `expect` with `toHaveNoViolations` from `jest-axe` for accessibility assertions
3. Polyfills `TextEncoder`/`TextDecoder`, `ResizeObserver`, and `matchMedia` for jsdom

### Render Helper (`tests/ui/test-utils.tsx`)

Use `renderWithIntl()` instead of bare `render()`:

```tsx
import { renderWithIntl } from "../test-utils";

renderWithIntl(<MyComponent />, { locale: "en" });
```

This wraps the component in `NextIntlClientProvider` (with merged UI + app messages), `QueryProvider`, and `ToastHost` so translations, React Query, and toasts work out of the box.

### Module Mocks (`tests/ui/__mocks__/`)

| Mock file | Replaces | Purpose |
|-----------|----------|---------|
| `next-cache.ts` | `next/cache` | Stubs server-side cache functions |
| `next-intl.tsx` | `next-intl` | Full context-based i18n implementation |
| `server-only.ts` | `server-only` | No-op so server-only modules can import |
| `style.ts` | `*.css/scss/sass/less` | Returns empty object for style imports |

These are wired through `moduleNameMapper` in `jest.config.ui.js`.

### Common In-Test Mocks

Many UI tests also mock routing and API modules inline:

```ts
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/console",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("next/link", () => ({ __esModule: true, default: (props: any) => <a {...props} /> }));
jest.mock("@masarx/api");
```

## E2E Tests (Playwright)

### Projects

The main Playwright config defines four projects, each matching specs by filename pattern:

| Project | Test match pattern | Base URL |
|---------|-------------------|----------|
| `console` | `console*.spec.ts` | `http://localhost:3001` |
| `a11y` | `a11y*.spec.ts` | `http://localhost:3001` |
| `shared` | `(action\|logging\|navigation\|labels)*.spec.ts` | `http://localhost:3001` |
| `portal` | `portal*.spec.ts` | `http://localhost:3002` |

### Configuration Highlights

- **Timeout:** 60 s per test, 10 s per assertion
- **Retries:** 2 in CI, 0 locally
- **Workers:** Defaults to 4 locally; CI uses Playwright default
- **Traces:** `on-first-retry` in CI, `retain-on-failure` locally
- **Screenshots/Video:** Captured only on failure

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `CONSOLE_BASE_URL` | Override console origin (required in CI) |
| `PORTAL_BASE_URL` | Override portal origin (required in CI) |
| `E2E_WORKERS` | Local worker count (default 4) |
| `LANDING_E2E_WORKERS` | Landing E2E worker count; integer `1` through `4` (default `1`) |
| `E2E_FORCE_CLEAN` | Clear `.next` cache before starting dev servers |
| `E2E_WEB_SERVER_TIMEOUT_MS` | Dev server startup timeout (default 180 s) |

When running locally without `CONSOLE_BASE_URL`/`PORTAL_BASE_URL`, Playwright auto-starts `dev:console` and `dev:portal`.

### E2E Utilities (`tests/e2e/utils/`)

Key helpers available to E2E specs:

- **`auth.ts` / `session.ts`** -- Authenticate and manage user sessions
- **`demo-accounts.ts` / `seed.ts`** -- Provision fixture identity data for test isolation
- **`base-urls.ts` / `base-paths.ts`** -- Resolve app origins and route prefixes
- **`navigation.ts`** -- Page navigation and route helpers
- **`coverage-routes.ts`** -- Build signed-in coverage route lists from static pages plus authenticated non-resource navigation exposure; generic `:resource` workspace surfaces and dedicated import routes are intentionally left to focused feature specs
- **`performance.ts`** -- Measure and assert page load times
- **`error-guards.ts` / `runtime-errors.ts`** -- Detect console errors during tests

### Landing E2E

Uses a separate config (`playwright.landing.config.ts`) pointing at `tests/landing-e2e/`. Defaults to `http://127.0.0.1:3333`, one worker, and auto-starts `dev:landing` locally. Override the URL with `LANDING_BASE_URL` or `LANDING_E2E_PORT`; set `LANDING_E2E_WORKERS` to an integer from `1` through `4` when bounded parallelism is appropriate.

### Console / Portal Local E2E

- Keep the browser base URL aligned with the host the Next server is actually serving.
- If Console or Portal E2E runs target `127.0.0.1`, set `NEXT_PUBLIC_ALLOWED_DEV_ORIGINS=127.0.0.1` in the selected local env file so `allowedDevOrigins` is resolved dynamically and local verification does not fail on blocked dev assets.
- For long signed-in coverage sweeps, prefer a built server (`next build` + `next start`) when `next dev` becomes unstable on local runners.

## Writing New Tests

- **Unit test:** Add `tests/unit/<area>/<name>.test.ts`. No special setup needed.
- **UI test:** Add `tests/ui/<area>/<Component>.test.tsx`. Use `renderWithIntl()` from `test-utils`. Add inline mocks for routing and API as needed.
- **E2E spec:** Add `tests/e2e/<project-pattern>.spec.ts`. Name the file to match the project pattern it belongs to (e.g. `console-settings.spec.ts` for the console project). Use utilities from `tests/e2e/utils/` for auth and navigation.
