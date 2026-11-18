# Frontend Performance

## Bundle Budgets

Per-route JavaScript + CSS size limits are defined in
`config/tooling/bundle-budgets.json`. Each route has a `maxBytes` ceiling
(currently ~1.48--1.49 MB per route) and the file carries a `defaultMaxBytes`
fallback (~1.63 MB). Budgets are generated with a **10 % safety buffer** over
the measured `currentBytes`.

The enforcement script is `scripts/frontend/check-bundle-budgets.js`. It reads
the `.next/app-build-manifest.json` (or `build-manifest.json`) and
`.next/app-path-routes-manifest.json` produced by `next build`, sums each
route's JS/CSS assets, and compares them against the budget file.

| Command | Purpose |
|---|---|
| `npm run check:bundle-budgets` | Verify current build against budgets (CI) |
| `npm run check:bundle-budgets:write` | Regenerate budgets from the latest build |
| `npm run analyze:frontend` | Build both apps then check budgets |

To inspect bundles visually, set `ANALYZE=true` before building. This enables
`@next/bundle-analyzer` (configured in `config/shared/next-bundle-analyzer.js`).

## Build Configuration

`apps/console/next.config.js` (and the portal equivalent) set up:

- **Turbopack** -- `turbopack.root` points to the monorepo root.
- **React resolution** -- Next.js owns its layer-specific React aliases; the
  app configs do not override private `next/dist/compiled` paths.
- **transpilePackages** -- `@masarx/ui`, `@masarx/api`, `@masarx/auth`,
  `@masarx/config` are transpiled by Next.js.
- **Internationalization** -- `next-intl` plugin wraps the config.

Dev servers: console on port 3001, portal on port 3002.

## Code Splitting

### Lazy-loaded panels (React.lazy + Suspense)

Heavy UI panels are split out of the main bundle with `React.lazy()`:

- `TableExportPanel` -- `packages/ui/src/resource-table.tsx`
- `ConditionalFormattingPanel` -- `packages/ui/src/resource-table.tsx`
- `AccessPolicyEditor` -- `packages/ui/src/access-policy-request-form.tsx`
- `CommandPalette` -- `packages/ui/src/navigation-next.tsx`

Each is wrapped in a `<Suspense>` boundary so the chunk is fetched only when
the panel is first rendered.

### Page-level splits (next/dynamic)

`WorkflowTemplateStudioPage` uses `next/dynamic` in both
`apps/console/app/workflows/templates/[template_id]/page.tsx` and the portal
equivalent to defer loading of the studio editor.

## Memoization

- `packages/ui/src/resource-table.tsx` makes extensive use of `useMemo` and
  `useCallback` (150+ instances) to produce stable references for derived data,
  event handlers, and column definitions.
- `TableViewport` (`packages/ui/src/table/viewport.tsx`) is wrapped with
  `React.memo` to skip re-renders when props are unchanged.
- Stable handler references prevent child components from re-rendering on
  every parent render cycle.

## Virtualization

Tables use `@tanstack/react-virtual` (see `packages/ui/src/table/table-rows.ts`
and `packages/ui/src/table/body.tsx`).

Key settings:

| Parameter | Value | Notes |
|---|---|---|
| Overscan | 8 rows (default) | Configurable per table via prop |
| Row height estimation | Dynamic by row type | `base`, `group`, `detail` |
| Off-screen space | `paddingTop` / `paddingBottom` spacer rows | Keeps scroll height accurate |

The virtualizer renders only the visible rows plus the overscan buffer. Spacer
`<td>` elements above and below the visible window maintain the correct total
scroll height.

## Data Fetching (React Query)

Global defaults are set in `packages/ui/src/query-provider.tsx`:

```
staleTime: 30_000        // 30 s before data is considered stale
refetchOnWindowFocus: false
retry: 1
retryDelay: exponential  // min(1000 * 2^attempt, 3000)
```

`useResourceQuery` (`packages/ui/src/hooks/use-resource-query.ts`) adds:

- **`placeholderData: keepPreviousData`** -- the previous page's data stays
  visible while the next page loads, preventing layout flash.
- **`initialData`** from SSR -- when the server pre-fetches a list, it is
  passed as `initialData` so the client skips the first network request.

## Search Debouncing

Search input is debounced before triggering a query. The delay is configurable
at multiple levels:

| Source | Default |
|---|---|
| `UI_PAGINATION_DEFAULTS.searchDebounceMs` | 300 ms |
| `NEXT_PUBLIC_UI_SEARCH_DEBOUNCE_MS` env var | overrides default |
| Per-view `search_debounce_ms` | overrides env var |
| Allowed presets | 0, 150, 300, 600, 1000 ms |

Users can change the debounce per saved table view through the toolbar.

## Images

No `next/image` usage; icons are inline SVG React components.
