# Frontend Architecture

Reference documentation for the MasarX frontend monorepo.

## Monorepo Structure

npm workspaces with two workspace roots: `apps/*` and `packages/*`.

| Workspace | Package | Type | Port |
|-----------|---------|------|------|
| `apps/console` | `@masarx/console` | Next.js 16 App Router | 3001 |
| `apps/portal` | `@masarx/portal` | Next.js 16 App Router | 3002 |
| `apps/fieldops` | `@masarx/fieldops` | Expo / React Native | -- |
| `packages/ui` | `@masarx/ui` | Shared UI components | -- |
| `packages/api` | `@masarx/api` | Supabase RPC client | -- |
| `packages/auth` | `@masarx/auth` | Supabase Auth helpers | -- |
| `packages/config` | `@masarx/config` | Config, i18n messages, UiDefaults | -- |

Shared Next.js utilities (layout, security headers, fonts, React singleton aliasing) live in `apps/shared/`.

## Next.js Configuration

Each app has its own `next.config.js` with:

- **Turbopack** enabled (`turbopack.root` points to monorepo root)
- **transpilePackages**: `@masarx/ui`, `@masarx/api`, `@masarx/auth`, `@masarx/config`
- **React singleton aliasing** via `apps/shared/next-react-singleton.js` in the webpack config to prevent duplicate React bundles across workspaces
- **next-intl plugin** loaded from each app's `i18n/request.ts`
- **Root-served routing** for Console/Portal on dedicated subdomains (no Next.js `basePath` deployment contract)
- **Security headers** applied via `apps/shared/security-headers.js`
- **Bundle analyzer** available via `apps/shared/next-bundle-analyzer.js`

## Component Model

### Server Components

Files that import `"server-only"` (e.g., `packages/api/src/server.ts`). Page-level server components fetch data via `createUiServerClient()` and pass results as props to client components.

Example: `packages/ui/src/resource-page.tsx` calls `createUiServerClient()` to load list data, then renders `resource-table-client.tsx`.

### Client Components

Files with the `"use client"` directive (e.g., `packages/ui/src/resource-table-client.tsx`, `packages/ui/src/resource-detail-client.tsx`). Handle interactive UI, form inputs, and client-side data refetching via React Query hooks.

## Data Fetching

### Server-side: `createUiServerClient()`

Defined in `packages/api/src/server.ts`. Wraps `@masarx/auth/server`'s `createServerClient` to create a Supabase client scoped to the `api` schema, then exposes typed RPC methods (`me()`, `navigation()`, `listResource()`, `getResource()`, etc.).

Deduplication: the client instance is memoized with React `cache()`, and each RPC call is further memoized within the request via a stable-key Map. Multiple server components calling the same RPC in one render get a single network request.

### Client-side: React Query v5

Hooks in `packages/ui/src/hooks/`:

- **`useResourceQuery`** (`use-resource-query.ts`) -- paginated list queries with `staleTime: 30_000`, `keepPreviousData`, and optional `initialData` from the server render.
- **`useResourceDetail`** (`use-resource-detail.ts`) -- single-resource detail queries with `staleTime: 30_000`.
- **`useResourceListInvalidate`** -- invalidates all cached queries for a resource key after mutations.

Client-side queries call `createUiClient()` from `packages/api/src/ui-client.ts`, which uses a browser Supabase client.

## State Management

| Layer | Mechanism | Examples |
|-------|-----------|---------|
| Server data | React Query cache | Resource lists, detail records |
| URL state | `window.history.replaceState` + query params | Filters, pagination, sort |
| Persistent prefs | `localStorage` | Navigation prefs, detail panel prefs, collapsed sections |
| Ephemeral UI | React `useState` | Panel toggles, inline editing |

## Authentication

Built on Supabase Auth via `@supabase/ssr`. Supported methods: `magic_link` and `password` (configured via `NEXT_PUBLIC_AUTH_METHODS`).

Key files:

- `packages/auth/src/server.ts` -- creates a server-side Supabase client that reads/writes cookies via `next/headers`
- `packages/auth/src/browser.ts` -- browser client entry
- `packages/auth/src/next.ts` -- `handleAuthCallback()` exchanges auth codes for sessions; `handleSignOut()` clears the session
- Each app has `app/auth/callback/` and `app/auth/sign-out/` route handlers
- `/signin` is an alias route that redirects to `/` (canonical auth entry)

The root layout (`apps/shared/app-layout.tsx`) checks the session server-side and wraps children with `<AuthGate>`, which forces authentication when no session exists.

## App Context and Page HOCs

Each app defines an `app-context.ts` (e.g., `apps/console/app/app-context.ts`) that exports:

- **`getConsoleAppContext()`** / **`getPortalAppContext()`** -- async function returning `AppContext` with `appKey`, `appBasePath`, `appName`, `config`, `locale`, `messages`, etc.
- **`withConsoleConfig(render)`** / **`withPortalConfig(render)`** -- HOC wrapping page components. Loads context, validates config is present, resolves async page props, then calls the render function with the context.

Page files are thin wrappers:

```ts
// apps/console/app/page.tsx
import { DashboardPage } from "@masarx/ui";
import { withConsoleConfig } from "./app-context";

export default withConsoleConfig(({ appName, appBasePath, appKey, locale, messages }) => (
  <DashboardPage appLabel={appName} appKey={appKey} appBasePath={appBasePath} ... />
));
```

The `createConfigGuardedPage` and `createAppContext` utilities are defined in `apps/shared/app-layout.tsx`.

## Layout

The root layout is created by `createRootLayout()` in `apps/shared/app-layout.tsx`. It provides:

1. `<html>` with `lang` and `dir` attributes (RTL-aware)
2. `<NextIntlClientProvider>` for i18n
3. `<ThemeProvider>` for dark/light theme
4. `<QueryProvider>` for React Query
5. `<ToastHost>` for notifications
6. `<UiNavigationProvider>` with navigation sections from the server
7. `<AppShell>` with sidebar navigation (`<NavigationNext>`) and `<ContextStrip>` (user/org/scope display)
8. `<AuthGate>` wrapping page children

Layout mode (`contained` or `full`) and `maxWidth` come from `getUiDefaults()`.

## Internationalization (i18n)

Uses `next-intl` with bilingual support (English and Arabic).

- Message files: `packages/config/messages/en.json`, `packages/config/messages/ar.json`
- `resolveUiMessages(locale)` in `packages/config/src/messages.ts` resolves the message bundle for a locale
- `createUiTranslator(namespace?, options?)` in `packages/ui/src/i18n.ts` creates a translator for non-hook contexts (server components, utilities)
- RTL locales configured via `UI_LOCALE_DEFAULTS.rtlLocales` (default: `["ar"]`)
- Each app has an `i18n/` directory with a `request.ts` entry for the next-intl plugin

## UiDefaults

`getUiDefaults()` from `packages/config/src/index.ts` reads `NEXT_PUBLIC_UI_*` env vars and returns a typed `UiDefaults` object with sections:

- **pagination** -- `defaultPageSize` (25), `maxPageSize` (200), `allowedPageSizes`, `searchDebounceMs` (300), `pagingMode` (server/client)
- **navigation** -- `maxRecents` (6), `maxFavorites` (8), sidebar defaults, keyboard shortcuts (`ctrl+b`, `mod+k`)
- **layout** -- `mode` (contained/full), `maxWidth` (1200px)
- **table** -- column widths, row heights, virtualization overscan, view tabs max, truncation

All values have sensible defaults and can be overridden per-deployment via environment variables.

## Shared Packages

### `@masarx/ui`

Exports from `packages/ui/src/index.ts` (server-safe) and `packages/ui/src/client.ts` (`"use client"` components). Built on Radix UI primitives, Tailwind CSS, and `@tanstack/react-virtual` for virtualized lists. Includes a Tailwind preset at `packages/ui/tailwind-preset.js`.

### `@masarx/api`

Three entry points:
- `.` (`packages/api/src/index.ts`) -- types and shared utilities
- `./server` (`packages/api/src/server.ts`) -- server-only `createUiServerClient()` with React `cache()` memoization
- `./mobile` (`packages/api/src/mobile.ts`) -- mobile client entry

### `@masarx/auth`

Four entry points:
- `.` (`packages/auth/src/index.ts`) -- re-exports
- `./server` -- server-side Supabase client with cookie handling
- `./browser` -- browser-side client
- `./next` -- Next.js route handlers (`handleAuthCallback`, `handleSignOut`)
- `./mobile` -- mobile auth

### `@masarx/config`

Exports `getPublicConfig()`, `getUiDefaults()`, `resolveUiMessages()`, UI default constants, and type definitions. Single source of truth for all deployment-time configuration.

## Dev Commands

```
npm run dev:console    # Next.js dev on port 3001
npm run dev:portal     # Next.js dev on port 3002
npm run dev:fieldops   # Expo start
npm run test:ui        # Jest UI component tests
npm run test:e2e       # Playwright end-to-end tests
npm run lint:frontend  # Frontend lint
npm run typecheck:frontend  # TypeScript check (console + portal)
npm run storybook      # Storybook on port 6006
```
