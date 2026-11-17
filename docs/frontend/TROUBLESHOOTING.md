# Frontend Troubleshooting Guide

## Build Failures

### "Invalid hook call" / Duplicate React

Internal `@masarx/*` packages can bundle their own React. `next.config.js` aliases React to a single copy via `config.resolve.alias`. If the error persists, run `npm ls react` from the repo root to find duplicates.

### transpilePackages errors

Build fails on `@masarx/*` imports when a package is missing from `transpilePackages` in `next.config.js`. Add the missing package to the array.

### Turbopack issues in dev

Turbopack is enabled for `next dev`. To bypass a Turbopack-specific bug: `npx next dev --no-turbo`

---

## Environment Variables

`getRequiredEnv` throws at startup if these are missing:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key |

**Fix:** Copy `.env.example` to `.env.local` and fill in values.

Optional variables (`NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_AUTH_METHODS`, `NEXT_PUBLIC_LOCALE`, `NEXT_PUBLIC_UI_*`) have built-in defaults and are safe to omit.

---

## Test Failures

### Module not found in Jest

Jest cannot resolve `next/cache`, `next-intl`, `server-only`, or CSS imports. These are mapped in `jest.config.ui.js` via `moduleNameMapper` to mocks under `tests/ui/__mocks__/`. Verify the mappings and mock files exist.

### JSON import errors in tests

`SyntaxError: Unexpected token` on `.json` imports means `tsconfig.jest.json` needs `esModuleInterop: true` and `resolveJsonModule: true`.

### Missing DOM APIs (TextEncoder, ResizeObserver, matchMedia)

These are polyfilled in `tests/ui/setup.ts`. Ensure `jest.config.ui.js` has:
```js
testEnvironment: 'jsdom',
setupFilesAfterSetup: ['<rootDir>/tests/ui/setup.ts']
```

### Async component assertions fail

Components using `React.lazy` need async queries:
```ts
// Wrong -- returns nothing for lazy-loaded components
screen.getByRole('button')
// Correct
await screen.findByRole('button')
```

---

## CSS and Styling

Design tokens use the `ui-` prefix in Tailwind config: `ui-border`, `ui-ink`, `ui-muted`, `ui-paper`, `ui-surface`, `ui-highlight`, `ui-accent`, `ui-danger`.

If `text-ui-ink` or `bg-ui-surface` has no effect, verify the token exists in `theme.extend.colors` of the Tailwind config.

---

## Internationalization (i18n)

**Raw keys showing (e.g. `common.save`):** Check the key exists in `packages/config/src/messages/en.json` and `ar.json`.

**Translations outside React components:** Use `createUiTranslator` from `@masarx/config` instead of the `useTranslations` hook.

**Test mocks:** The mock at `tests/ui/__mocks__/next-intl.tsx` provides `useTranslations`, `useLocale`, etc. Ensure it is mapped in `moduleNameMapper`.

---

## Module Resolution

### Cannot find module `@masarx/*`

1. Run `npm install` from the **repo root** (not from an app directory).
2. Verify `tsconfig.base.json` has `baseUrl: "."` -- resolution relies on npm workspaces, not path aliases.
3. Check the package is listed in the root `package.json` workspaces array.

---

## Local Development

### Port conflicts

| App | Port |
|---|---|
| Console | 3001 |
| Portal | 3002 |

Kill a blocked port: `lsof -ti :3001 | xargs kill -9`
Or use a custom port: `npx next dev -p 3005`

### Stale dependencies after pulling changes

```bash
npm install        # from repo root
npm run build      # rebuild internal packages if needed
```

---

## E2E / Playwright

**Browser not installed:** Run `npx playwright install --with-deps`

**E2E tests fail in CI:** Set `CONSOLE_BASE_URL=http://localhost:3001` and `PORTAL_BASE_URL=http://localhost:3002` in your CI config. Ensure dev servers are running before the test suite starts.
