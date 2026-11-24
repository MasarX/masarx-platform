# Design contract

## 1. Scope and status

This file is the look-and-feel contract. Sections 1–8 describe the shipped implementation, section 9 governs UI changes, and section 10 records known gaps. Use the cited implementation to resolve discrepancies about current behavior.

| Surface | Shipped entry points |
| --- | --- |
| Console V2 | The newer operator workbench. Its router maps supported legacy locations to V2 modules. The root script `dev:console:v2` selects it. `apps/console-v2/src/App.tsx`, `apps/console-v2/src/lib/legacy-routes.ts`, `package.json` |
| Next.js console and portal | Both remain runnable. `dev:console` and `dev:console:legacy` select the Next.js console. Console and portal both use `createRootLayout` and the same shared UI package. The console requires authentication by default and the portal layout uses optional authentication. `package.json`, `apps/console/app/layout.tsx`, `apps/portal/app/layout.tsx`, `apps/shared/app-layout.tsx` |
| Landing and public tracking | Standalone HTML, CSS and JavaScript with their own components and tokens. `docs/marketing/landing-v2/index.html`, `docs/marketing/landing-v2/track.html`, `docs/marketing/landing-v2/app.css`, `docs/marketing/landing-v2/app.js` |

FieldOps theme files define light and dark semantic colors, radii and platform font stacks, with a system-mode resolver. The V2 theme files define light, dark and high-visibility (`hivis`, the default) palettes, typography, spacing, radii, dimensions and shadows. `apps/fieldops/src/mobile-theme.ts`, `apps/fieldops/src/mobile-theme-stylesheet.ts`, `apps/fieldops/src/mobile-v2-themes.ts`

## 2. Tokens

### Next.js console, portal and shared UI

Both `globals.css` files import the shared stylesheet. Both Tailwind configs extend the shared preset, which maps the core `ui-*` RGB channels to alpha-aware utilities. `apps/console/app/globals.css`, `apps/portal/app/globals.css`, `apps/console/tailwind.config.js`, `apps/portal/tailwind.config.js`, `packages/ui/tailwind-preset.js`

| `--ui-*` suffixes, in order | Light RGB channels | Dark RGB channels | Source |
| --- | --- | --- | --- |
| `paper`, `surface`, `highlight` | `250 251 254`, `255 255 255`, `238 241 250` | `11 17 33`, `17 24 42`, `30 41 66` | `packages/ui/src/styles.css` |
| `ink`, `muted`, `border` | `15 23 42`, `71 85 105`, `226 232 240` | `241 245 249`, `148 163 184`, `45 55 80` | `packages/ui/src/styles.css` |
| `accent`, `accent-hover`, `accent-ink`, `accent-soft` | `79 70 229`, `67 56 202`, `255 255 255`, `224 231 255` | `129 140 248`, `165 180 252`, `11 17 33`, `30 27 75` | `packages/ui/src/styles.css` |
| `success`, `warning`, `danger`, `danger-ink`, `info` | `2 121 73`, `151 92 1`, `200 38 39`, `255 255 255`, `28 100 213` | `54 158 107`, `221 139 76`, `241 88 86`, `11 17 33`, `96 165 250` | `packages/ui/src/styles.css` |
| `shadow-rgb`, `shadow-pinned` opacity, `glow-accent` opacity | `15 23 42`, `0.12`, `0.18` | `0 0 0`, `0.35`, `0.25` | `packages/ui/src/styles.css` |
| `--table-*` overlays | `row-separator` uses border at 15%, `header-bg` highlight at 40%, `hover-bg` ink at 3%, `selected-bg` accent at 5% | 20%, 50%, 4%, 8% respectively | `packages/ui/src/styles.css` |

| `--tag-*` color | Light background / text | Dark background / text | Source |
| --- | --- | --- | --- |
| `gray`, `brown`, `orange` | `#f1f1ef / #6d6c69`, `#f4eeee / #8b624c`, `#fbecdd / #a55604` | `#373737 / #b0afac`, `#3e2f2a / #c49a82`, `#46300e / #e8944a` | `packages/ui/src/styles.css` |
| `yellow`, `green`, `blue` | `#fbf3db / #946400`, `#e6f5e4 / #397857`, `#e1eefa / #3f68b4` | `#3d3415 / #ddb561`, `#1e3a28 / #6db48a`, `#1d2d44 / #7da3e0` | `packages/ui/src/styles.css` |
| `purple`, `pink`, `red` | `#eee5f8 / #80559f`, `#f9e4ee / #af3c7b`, `#fce4e4 / #b1443d` | `#302440 / #b28fd0`, `#3e1e30 / #d97aad`, `#3e1e1e / #df8079` | `packages/ui/src/styles.css` |

| Token area | Shipped values | Source |
| --- | --- | --- |
| Typography | Inter for UI and display, Noto Sans Arabic as fallback, IBM Plex Mono for mono. Inter and Noto load weights 400/500/600/700 and Plex Mono loads 400/500. Shared fonts add no root class. The preset inherits the Tailwind type scale, including `xs/sm/base/lg/xl/2xl/3xl` at 0.75/0.875/1/1.125/1.25/1.5/1.875rem. Page components also use explicit sizes such as the 11px eyebrow. | `package.json`, `packages/ui/src/styles.css`, `packages/ui/tailwind-preset.js`, `apps/console/app/layout.tsx`, `apps/portal/app/layout.tsx`, `apps/shared/fonts.ts`, `packages/ui/src/page-header.tsx` |
| Spacing, radius and breakpoints | The preset inherits Tailwind defaults. The panel section uses `p-5` (1.25rem) and `rounded-xl` (0.75rem). Shared fields use `px-3 py-2.5` (0.75/0.625rem) and `rounded-lg` (0.5rem). Screen minima `sm/md/lg/xl/2xl` are 640/768/1024/1280/1536px. The shell uses `lg` and the split layout uses `md`. | `package.json`, `packages/ui/tailwind-preset.js`, `packages/ui/src/section.tsx`, `packages/ui/src/form-classes.ts`, `packages/ui/src/app-shell.tsx`, `packages/ui/src/resource-page-split-layout.tsx` |
| Shadow | `shadow-soft` uses `0 1px 2px` plus `0 10px 24px -20px` at 0.06/0.14 opacity in light, and `0 1px 2px` plus `0 14px 36px -26px` at 0.38/0.48 in dark, with the theme's shadow RGB. | `packages/ui/src/styles.css`, `packages/ui/tailwind-preset.js` |
| Motion | Table fast/normal transitions are 100/200ms. Preset durations are 220ms fade-in, 240ms fade-up and slide-up, 200ms slide-down, scale-in and slide-in-right, 150ms slide-out-right, 1.5s pulse-dot and 2s shimmer. | `packages/ui/src/styles.css`, `packages/ui/tailwind-preset.js` |
| Stacking | Modal and drawer overlays use z-index 80 and their content 90. The toast viewport and focused skip link use 50. | `packages/ui/src/modal.tsx`, `packages/ui/src/drawer.tsx`, `packages/ui/src/toast.tsx`, `packages/ui/src/app-shell.tsx` |

### Console V2

`tokens.css` is the source for the V2 palette. The CSS entry imports it before the base, shell and component styles. The root and V2 Tailwind configs also reference the shared preset. `apps/console-v2/src/styles/index.css`, `apps/console-v2/src/styles/tokens.css`, `tailwind.config.js`, `apps/console-v2/tailwind.config.cjs`

| Token suffixes or names, in order | Light OKLCH channels | Dark OKLCH channels | Source |
| --- | --- | --- | --- |
| `paper`, `paper-2`, `paper-3`, `paper-raise` | `0.992 0.003 80`, `0.978 0.004 80`, `0.962 0.005 80`, `1 0 0` | `0.16 0.008 250`, `0.13 0.008 250`, `0.11 0.008 250`, `0.19 0.009 250` | `apps/console-v2/src/styles/tokens.css` |
| `ink`, `ink-2`, `ink-3`, `ink-inv` | `0.20 0.012 250`, `0.38 0.012 250`, `0.46 0.012 250`, `0.99 0 0` | `0.92 0.005 250`, `0.74 0.008 250`, `0.60 0.008 250`, `0.10 0.008 250` | `apps/console-v2/src/styles/tokens.css` |
| `line`, `line-2`, `line-strong` | `0.91 0.005 80`, `0.86 0.006 80`, `0.78 0.008 80` | `0.26 0.010 250`, `0.32 0.010 250`, `0.42 0.012 250` | `apps/console-v2/src/styles/tokens.css` |
| `accent`, `accent-soft`, `accent-ink` | `0.45 0.13 158`, `0.94 0.05 158`, `0.32 0.10 158` | `0.68 0.13 158`, `0.28 0.06 158`, `0.85 0.12 158` | `apps/console-v2/src/styles/tokens.css` |
| `warn`, `warn-soft`, `warn-ink` | `0.68 0.14 60`, `0.96 0.05 80`, `0.40 0.12 60` | `0.78 0.14 70`, `0.30 0.08 70`, `0.88 0.12 70` | `apps/console-v2/src/styles/tokens.css` |
| `danger`, `danger-soft`, `danger-ink` | `0.58 0.18 28`, `0.96 0.04 28`, `0.42 0.16 28` | `0.70 0.16 28`, `0.30 0.10 28`, `0.85 0.14 28` | `apps/console-v2/src/styles/tokens.css` |
| `info`, `info-soft`, `info-ink` | `0.55 0.13 245`, `0.96 0.03 245`, `0.38 0.12 245` | `0.70 0.12 245`, `0.28 0.06 245`, `0.85 0.10 245` | `apps/console-v2/src/styles/tokens.css` |
| `chrome`, `chrome-ink`, `chrome-ink-soft`, `chrome-line` | `0.18 0.012 250`, `0.92 0.005 250`, `0.72 0.012 250`, `0.28 0.012 250` | `0.10 0.008 250`, `0.92 0.005 250`, `0.70 0.012 250`, `0.20 0.010 250` | `apps/console-v2/src/styles/tokens.css` |
| `cmd-bg`, `cmd-kbd`, `rail-bg`, `rail-ink` | `0.24 0.012 250`, `0.30 0.012 250`, `0.97 0.005 80`, `0.42 0.012 250` | `0.16 0.010 250`, `0.22 0.010 250`, `0.13 0.008 250`, `0.74 0.008 250` | `apps/console-v2/src/styles/tokens.css` |

`--good`, `--good-soft` and `--good-ink` alias their `accent` counterparts in both themes. `apps/console-v2/src/styles/tokens.css`

| Token area | Shipped values | Source |
| --- | --- | --- |
| Typography | Geist for `--font-ui` and `--font-display` with IBM Plex Sans Arabic and system fallbacks, Geist Mono for `--font-mono`. `--text-2xs/xs/sm/base/md/lg/xl/2xl/3xl` are 11/12/13/14/15/18/24/30/38px. The HTML requests Geist 400–800, Geist Mono 400–600 and Plex Arabic 400–700 at 100 increments. | `apps/console-v2/src/styles/tokens.css`, `apps/console-v2/index.html` |
| Spacing and density | `--s-1/2/3/4/5/6/8/10/12` are 4/8/12/16/20/24/32/40/48px. Row and cell vertical/horizontal padding are 4/8px compact, 6/10px comfortable and 9/12px cozy. | `apps/console-v2/src/styles/tokens.css` |
| Radius and shell | `--r-1/2/3/4/pill` are 3/4/6/8/999px. `--topbar-h` 44px, `--sidenav-w` 240px, `--sidenav-w-collapsed` 56px, `--sidenav-w-rail` 52px, `--evidence-h` 28px and `--notifs-w` 360px. | `apps/console-v2/src/styles/tokens.css` |
| Shadow and focus | `--shadow-soft` uses `0 1px 2px` and `0 4px 12px` at 0.06/0.04 opacity in light, 0.5/0.4 in dark. `--shadow-pop` uses `0 8px 24px` and `0 1px 4px` at 0.16/0.08 in light, 0.6/0.4 in dark. Both use `oklch(0.20 0.012 250)` in light and black in dark. `--focus-ring` layers 2px of paper and 4px of accent. | `apps/console-v2/src/styles/tokens.css` |
| Motion and stacking | Fast/base/drawer are 100/160/220ms with `cubic-bezier(0.2, 0.8, 0.2, 1)`. Rail/top bar/drawer/modal/palette/toast are 30/40/60/70/80/90. The notifications panel, navigation flyout and skip link use local z-index values 50, 100 and 1000. | `apps/console-v2/src/styles/tokens.css`, `apps/console-v2/src/styles/shell.css`, `apps/console-v2/src/styles/base.css` |
| Breakpoints | Page headers reflow at max-width 720px. Module rules also use max-width 980px and 1100px. Split-table pages change at max-height 700px, and modules include a max-height 760px rule. | `apps/console-v2/src/styles/components.css`, `apps/console-v2/src/styles/modules.css` |

### Landing and public tracking

The landing build prepends the shared `--ui-*` declarations, and only those, to `app.css`. `--bg` aliases `paper`, `--text` aliases `ink`, `--brand` aliases the light `accent`, and light `--surface-strong` aliases `surface`, all with unchanged values. The other values below differ from the shared tokens and form the one landing override at the top of `app.css`: `--muted`, dark `--surface-strong` and `--brand`, `--accent`, `--accent-2`, the translucent `--surface`, the 12/16/20/28px radii and the system font stacks. `scripts/frontend/build-landing.js`, `scripts/frontend/landing-shared-tokens.js`, `docs/marketing/landing-v2/app.css`

| Token area | Shipped values | Source |
| --- | --- | --- |
| Brand | `--brand` `#4F46E5`, `--accent` `#818CF8`, `--accent-2` `#10B981` and `--btn-primary-text` `#ffffff` under `data-variant="ai"` in both themes. | `docs/marketing/landing-v2/app.css`, `docs/marketing/landing-v2/index.html`, `docs/marketing/landing-v2/track.html` |
| Background and surfaces | `--bg` `#FAFBFE` / `#0B1121`, `--surface` `rgba(255, 255, 255, 0.92)` / `rgba(15, 23, 42, 0.80)`, `--surface-strong` `#ffffff` / `#111827` in light / dark order. | `docs/marketing/landing-v2/app.css` |
| Text, grid and border | `--text` `#0F172A` / `#F1F5F9` and `--muted` `#546275` / `rgba(241, 245, 249, 0.65)`. For `rgba(79, 70, 229, alpha)`, light/dark alpha is 0.10/0.18 for `--border`, 0.03/0.06 for `--tint-1`, 0.06/0.10 for `--tint-2`, 0.06/0.10 for `--grid-a` and 0.03/0.05 for `--grid-b`. `--grid-opacity` is 0.10/0.30. | `docs/marketing/landing-v2/app.css` |
| Hero wash | `--wash-1/2/3` mix brand, accent and accent-2 with transparent at 14/8/6% in light and 18/12/8% in dark. | `docs/marketing/landing-v2/app.css` |
| Typography | System-first sans stacks, with Noto Sans Arabic, IBM Plex Sans Arabic and Tajawal in the Arabic fallback list, and a system monospace stack. Selector-level sizes include 14px navigation/buttons, 16px card titles, 17px section leads, `clamp(26px, 2.5vw, 36px)` section headings and `clamp(40px, 4vw, 68px)` hero headings. | `docs/marketing/landing-v2/app.css` |
| Spacing and radius | `--gutter` `clamp(18px, 3vw, 28px)`, `--scroll-offset` 92px, `--safe-left/right` from safe-area insets with 0px fallbacks. Section padding is `clamp(72px, 8vw, 140px)` vertically. `--radius-sm/md/lg/xl/pill` are 12/16/20/28/999px. | `docs/marketing/landing-v2/app.css` |
| Shadow | `--shadow-sm` layers `0 1px 3px` and `0 8px 24px`, with black at 0.04/0.06 light and 0.20/0.30 dark. `--shadow-md` layers `0 2px 4px` and `0 12px 40px`, with black at 0.04/0.08 light and 0.20/0.35 dark. | `docs/marketing/landing-v2/app.css` |
| Motion and stacking | `--dur-fast`, `--dur` and `--dur-slow` are 130/220/420ms with `cubic-bezier(0.2, 0.8, 0.2, 1)`. Floating CTA/mobile menu/header/map overlay/skip link use z-index 40/49/50/80/999. Map confirmation and expansion controls use 1200 within the map UI. | `docs/marketing/landing-v2/app.css` |
| Breakpoints | Marketing uses max-width 768px and 560px. Public tracking adds max-width 1100px and 720px. | `docs/marketing/landing-v2/app.css` |

## 3. Theming

| Surface | Choice, persistence and application |
| --- | --- |
| Next.js console and portal | `ThemeToggle` offers system, light and dark. System is the default and listens for OS changes. Explicit overrides are stored in `localStorage["masarx-ui-theme"]` and system mode clears that key. The provider sets root `data-theme` and `color-scheme`. `packages/ui/src/theme-toggle.tsx`, `packages/ui/src/theme.tsx` |
| Console V2 | Starts with light/comfortable in HTML. The provider initializes from `console-v2.theme` and `console-v2.density` in local storage, applies root `data-theme` and `data-density`, and persists them. The top bar toggles light/dark and cycles compact, comfortable and cozy. `apps/console-v2/index.html`, `apps/console-v2/src/lib/theme.tsx`, `apps/console-v2/src/shell/Topbar.tsx` |
| Landing and public tracking | Follows the shared contract in the Next.js row: `localStorage["masarx-ui-theme"]` holds `light` or `dark` for an explicit choice, and no stored value means system mode, which follows live OS changes. Startup order is a valid `?theme=` override, the shared key, a choice saved under the old `masarx_theme` key (moved to the shared key once), then the OS. An untouched visit stores nothing. HTML `data-theme="light"` only covers the paint before the script runs. The toggle flips light and dark and stores the choice. Motion uses query, `masarx_motion`, HTML `data-motion`, then system preference, with a separate reduced-motion CSS override. `docs/marketing/landing-v2/app.js`, `docs/marketing/landing-v2/index.html`, `docs/marketing/landing-v2/track.html`, `docs/marketing/landing-v2/app.css` |

## 4. Layout

| Surface | Shell, page structure and responsive behavior |
| --- | --- |
| Next.js console and portal | Shared full-height shell, capability-aware sections, breadcrumbs and a context strip followed by page content. The default contained shell is 1200px, configurable, with a full-width option. `PageContainer` defaults to full width and can opt into the shell cap. At `lg`, the desktop sidebar is collapsible and uses `w-72` when open. Smaller widths use a navigation drawer. Resource split layouts switch from stacked to side-by-side at `md`. `apps/shared/app-layout.tsx`, `packages/config/src/ui-defaults.ts`, `packages/ui/src/app-shell.tsx`, `packages/ui/src/navigation-next.tsx`, `packages/ui/src/page-container.tsx`, `packages/ui/src/resource-page-split-layout.tsx` |
| Console V2 | Viewport grid without a shared page max width. Top bar holds navigation context, search and preferences. The side navigation uses a 52px rail and a 240px pinned mode. Main scrolls internally and the status bar spans the bottom. The notifications panel can reserve a 360px gutter. Pages use a title/actions header and may use split-table scrolling. Below the 720px header breakpoint the title, pills and actions take full rows. At 720px and below the shell is one column: a top bar navigation control opens the side navigation as an inline-start overlay drawer, which starts closed and closes on navigation, and the notifications gutter is dropped. `apps/console-v2/src/shell/AppShell.tsx`, `apps/console-v2/src/shell/Sidenav.tsx`, `apps/console-v2/src/shell/Topbar.tsx`, `apps/console-v2/src/styles/tokens.css`, `apps/console-v2/src/styles/shell.css`, `apps/console-v2/src/styles/components.css` |
| Landing and public tracking | Sticky header, centered sections and footer. `.container` is the smaller of `clamp(960px, 92vw, 1440px)` and viewport width minus two gutters. Header navigation collapses and primary grids stack at 768px. At 560px the header hides the primary CTA. Tracking stacks its main columns at 1100px and reduces card grids to one column at 720px. `docs/marketing/landing-v2/index.html`, `docs/marketing/landing-v2/track.html`, `docs/marketing/landing-v2/app.css` |

## 5. Components

The Next.js apps use repository-owned Tailwind components with Radix primitives for dialogs, drawers, dropdowns, tabs, tooltips and toasts. Console V2 uses its own CSS and components, with Radix Dialog for its overlays and cmdk for its palette. Landing uses native HTML controls and local styles. `packages/ui/package.json`, `packages/ui/src/index.ts`, `packages/ui/src/client.ts`, `apps/console-v2/src/components/Drawer.tsx`, `apps/console-v2/src/components/Modal.tsx`, `apps/console-v2/src/components/Palette.tsx`, `docs/marketing/landing-v2/index.html`

| Surface | Shared components and options |
| --- | --- |
| Next.js console and portal | `AppShell`, `NavigationNext`, `ContextStrip`, `PageContainer`, `PageHeader` and `Section` build pages. `Section` is panel/plain and can collapse. `Button` is solid/ghost/soft with sm/md/lg and disabled/loading states. `Badge` is neutral/accent/success/warning/danger/info with sm/md/lg and optional dot/icon. `packages/ui/src/index.ts`, `packages/ui/src/section.tsx`, `packages/ui/src/button.tsx`, `packages/ui/src/badge.tsx` |
| Next.js console and portal | `FormField`, `Input`, `Select`, `Textarea`, `Checkbox`, `RadioGroup`, `Switch`, `Combobox` and date/time pickers cover forms. Inputs and selects expose invalid and disabled states. `ResourceTable` and `ResourceDetail` cover records. `Modal`, `Drawer`, `ConfirmDialog`, `Tabs`, `Dropdown`, `Tooltip`, `CommandPalette` and `ToastHost` cover interaction and feedback. Drawers accept left/right/start/end. Toast tones are neutral/success/error/warning/info. `packages/ui/src/index.ts`, `packages/ui/src/client.ts`, `packages/ui/src/input.tsx`, `packages/ui/src/select.tsx`, `packages/ui/src/drawer.tsx`, `packages/ui/src/use-toast.tsx` |
| Console V2 | `PageHeader`, `KPICard`, `DataTable` and `RelatedRail` compose workbenches. `Button` supports primary/ghost/danger, sm/md and capability-disabled states. `Chip` supports good/warn/danger/info/neutral/ink and xs/sm. `Drawer` exposes sm/md/lg/xl and optional expansion, with base width 480px, lg 720px, xl 960px and a 92vw cap before expansion. `Modal`, `Palette`, `StateView`, `Spinner` and `Toast` cover overlays and feedback. Toast tones are good/warn/danger/info. `apps/console-v2/src/components`, `apps/console-v2/src/styles/components.css` |
| Landing and public tracking | Primary/ghost buttons, badges, cards, disclosure panels, form controls and inline status messages use local classes. Tracking adds step, timeline, request banner and map-dialog components. `docs/marketing/landing-v2/index.html`, `docs/marketing/landing-v2/track.html`, `docs/marketing/landing-v2/app.css` |

## 6. States

| Surface | Shipped states |
| --- | --- |
| Next.js console and portal | Root loading renders a localized heading and `LoadingState` with page/section skeleton variants. `EmptyState` has page/inline/card variants and accepts an action. Root not-found includes a home action. Route errors render `ErrorState` with reset, and the global fallback supplies its own shell. Missing configuration renders `MissingEnvNotice` with required/optional guidance and an error label. `AuthGate` handles sign-in and access errors. `apps/shared/app-fallbacks.tsx`, `apps/shared/app-error.tsx`, `apps/shared/missing-env.tsx`, `apps/shared/app-layout.tsx`, `packages/ui/src/loading-state.tsx`, `packages/ui/src/empty-state.tsx`, `packages/ui/src/auth-gate.tsx` |
| Console V2 | `StateView` supports loading/empty/error/denied with optional action or capability lock. The router shows retry on error, redirects recognized legacy routes via a loading view, and otherwise shows not-found with a dashboard action. Auth and metadata have loading, error and permission-denied guard views. The outer render boundary has its own alert and retry. Missing backend configuration yields a null client. Seed behavior is gated by seed mode, and live sign-in requires a configured client. `apps/console-v2/src/components/StateView.tsx`, `apps/console-v2/src/components/ErrorBoundary.tsx`, `apps/console-v2/src/App.tsx`, `apps/console-v2/src/shell/AppGuard.tsx`, `apps/console-v2/src/lib/supabase.ts`, `apps/console-v2/src/lib/seed-loader.ts`, `apps/console-v2/src/lib/auth.ts` |
| Landing and public tracking | Forms disable submit while requests run and update localized inline status. Tracking has an empty timeline fallback and renders unavailable request controls conditionally. Runtime-dependent links can be hidden when unset. `docs/marketing/landing-v2/app.js`, `docs/marketing/landing-v2/index.html`, `docs/marketing/landing-v2/track.html` |

## 7. Language and direction

| Surface | Locale, RTL and formatting |
| --- | --- |
| Next.js console and portal | Merge shared and app EN/AR catalogs. The locale comes from app configuration, defaulting to English. The primary language subtag selects messages with English fallback and determines RTL against the configured list, which defaults to `ar`. The server sets root `lang` and `dir`, and the missing-configuration and global-error documents derive `dir` from the same locale and RTL list. The shared shell and sections use inline utilities such as `border-e` and `border-s`. Shared resource formatting uses `Intl` with configured locale and an optional per-format timezone. `apps/shared/app-layout.tsx`, `apps/shared/i18n/direction.ts`, `apps/shared/missing-env.tsx`, `apps/shared/app-error.tsx`, `apps/shared/i18n/load-messages.ts`, `apps/console/i18n/index.ts`, `apps/portal/i18n/index.ts`, `packages/config/src/ui-defaults.ts`, `packages/ui/src/app-shell.tsx`, `packages/ui/src/section.tsx`, `packages/ui/src/resource-utils.ts` |
| Console V2 | EN/AR catalogs, English default, browser toggle and `console-v2.locale` in local storage. Sets root `lang` and `dir` and falls back from active catalog to English, supplied text or key. Router and auth guard fallbacks read the `route` and `guard` catalog sections. Stylesheet edges use logical inline-start/end properties. The few that stay physical, such as `translate(-50%)` centering, the right-side notifications panel and workflow-canvas coordinates, each carry a `/* physical: <why> */` comment. `rtl.css` prioritizes IBM Plex Sans Arabic, reverses the drawer slide and stepper arrow, and isolates IDs, numeric spans and timestamps in LTR runs. `Intl` helpers use the browser's preferred regional variant of the active language, else the bare `en` or `ar` tag, for dates, numbers and currency. Date/time uses the active tenant's `tenant_default_timezone` once identity has loaded (`TenantTimeZoneSync`), else `DISPLAY_TIME_ZONE`, the user's own time zone. Both are decided in `i18n.tsx`, and an invalid zone name falls back to the user's zone. Currency without a supplied code is formatted as a number. `apps/console-v2/src/lib/i18n.tsx`, `apps/console-v2/src/lib/seed-raw/i18n/en.js`, `apps/console-v2/src/lib/seed-raw/i18n/ar.js`, `apps/console-v2/src/shell/AppGuard.tsx`, `apps/console-v2/src/shell/RouteError.tsx`, `apps/console-v2/src/styles/rtl.css`, `apps/console-v2/src/styles/components.css`, `apps/console-v2/src/styles/shell.css` |
| Landing and public tracking | EN/AR content uses a localized path and language toggle. `setLang` updates root `lang`/`dir` and writes `masarx_lang`. CSS uses inline properties for containers, controls and the tracking timeline and flips the hero wash under RTL. The Arabic stack is selected by `html[lang="ar"]`. Tracking renders dates/windows with `Intl.DateTimeFormat` using the document language. `docs/marketing/landing-v2/content.js`, `docs/marketing/landing-v2/app.js`, `docs/marketing/landing-v2/app.css` |

## 8. Accessibility

| Area | Shipped behavior |
| --- | --- |
| Focus and landmarks | Shared buttons/fields use visible focus rings, and the shared shell provides a skip link. V2 uses `:focus-visible` with `--focus-ring` and a skip link to main. Landing has a skip link and visible button/map focus outlines. `packages/ui/src/button.tsx`, `packages/ui/src/form-classes.ts`, `packages/ui/src/app-shell.tsx`, `apps/console-v2/src/styles/base.css`, `apps/console-v2/src/shell/AppShell.tsx`, `docs/marketing/landing-v2/index.html`, `docs/marketing/landing-v2/app.css` |
| Labels and announcements | Shared fields wire invalid/error descriptions and the combobox exposes expanded and active-option state. Shared loading and empty views use polite status. V2 labels table selection/actions and announces toasts. Landing uses labels, navigation `aria-expanded` and polite form status. `packages/ui/src/input.tsx`, `packages/ui/src/combobox.tsx`, `packages/ui/src/loading-state.tsx`, `packages/ui/src/empty-state.tsx`, `apps/console-v2/src/components/DataTable.tsx`, `apps/console-v2/src/components/Toast.tsx`, `docs/marketing/landing-v2/index.html`, `docs/marketing/landing-v2/app.js` |
| Keyboard | Radix-backed dialogs/drawers provide keyboard dismissal and focus management. Shared shortcuts ignore editable targets and IME composition. V2 uses keyboard navigation in the command palette. Landing's expanded tracking map handles Escape, sets initial focus and restores focus on close. `packages/ui/src/modal.tsx`, `packages/ui/src/drawer.tsx`, `packages/ui/src/hooks/use-keyboard-shortcuts.ts`, `apps/console-v2/src/components/Palette.tsx`, `docs/marketing/landing-v2/app.js` |
| Target size | V2 compact icon buttons (table row actions, table group menu, dashboard widget edit actions) are 24 by 24 CSS px, the WCAG 2.2 AA 2.5.8 minimum. `apps/console-v2/tests/a11y/target-size.a11y.spec.ts` measures the rendered row and widget actions. |
| Contrast | Shared controls pair semantic foreground and surface tokens. `tests/unit/design-token-contrast.test.js` reads the shared UI, Console V2 and landing token files and requires 4.5:1 for each text pair and 3:1 for focus rings in both themes, including status badges on their 12% tint and the `--tag-*` pairs. `packages/ui/src/styles.css`, `apps/console-v2/src/styles/tokens.css`, `docs/marketing/landing-v2/app.css` |
| Reduced motion | Shared overlays use `motion-safe` and shared shimmer stops under reduced motion. V2 reduces animation and transition duration to 0.001ms and disables smooth scrolling under reduced motion. Landing disables motion via its attribute and OS media query. `packages/ui/src/modal.tsx`, `packages/ui/src/drawer.tsx`, `packages/ui/src/styles.css`, `apps/console-v2/src/styles/tokens.css`, `docs/marketing/landing-v2/app.css` |
| Lint | The root uses Next.js core-web-vitals and TypeScript presets. V2 has a separate TypeScript and React hooks config. FieldOps TSX has warning-level rules for hex colors outside theme files, off-scale spacing literals and raw typography literals. The i18n literal guard fails a unit test on English JSX text, user-facing props, toasts and error setters in Console V2, shared UI, FieldOps and the Next.js apps beyond its baseline, which lists each remaining file with a count that may only fall. Mark a deliberate literal, such as a brand name, with `i18n-literal-ok` on its line. `eslint.config.mjs`, `apps/console-v2/eslint.config.js`, `config/tooling/eslint.fieldops.js`, `scripts/tooling/i18n-literal-guard.js`, `scripts/tooling/i18n-literal-baseline.txt`, `tests/unit/i18n-literal-guard.test.js` |

## 9. Rules

### Tokens and components

- Use each surface's existing semantic tokens and shared components, and keep equivalent controls, states and interactions consistent across console, portal and landing.
- Keep hard-coded design colors, sizes and fonts in the surface's token files. Reference tokens or existing scale utilities from component code. Use the FieldOps token lint rules as precedent. `config/tooling/eslint.fieldops.js`
- Document every new token or shared component in `DESIGN.md` in the same PR.

### New screens

- Build a mockup from the real app components before implementing a new screen.
- The Design lead approves the mockup. No other review or owner sign-off is needed.

### Screen coverage

- Cover English and Arabic, including RTL mirroring and isolation of mixed-direction values.
- Cover light and dark themes, and desktop and phone widths.
- Cover loading, empty, error and permission-denied states, with text and a recovery action where one is available.

### Accessibility

- Keep keyboard focus visible and provide a skip link to main content.
- Label fields and icon-only controls, associate errors with fields, and announce asynchronous status through an appropriate live region.
- Pair semantic foreground and background tokens and use text for status alongside visual cues.
- Honor reduced motion and keep status and completion understandable with motion disabled.
- Support keyboard interaction, Escape dismissal, focus containment and focus restoration in modal overlays.
- **Best practice where coverage is incomplete.** Verify WCAG 2.2 AA contrast in both themes, including 4.5:1 for normal text, 3:1 for large text and 3:1 for essential component boundaries and states where the criteria apply.
- **Best practice where coverage is incomplete.** Keep focused controls visible, preserve a logical tab order, and verify 24 by 24 CSS pixel pointer targets or an applicable WCAG 2.2 AA exception.

### Speed

- Write a definition of usable for each screen that names what must be visible and interactive and what may still show “updating.”
- Measure time to usable in the browser on production-class hardware, and agree a tolerance for each number.
- Time user journeys and compare each result with the previous measurement under the same conditions.

| Screen | Visible and interactive at usable | May still show “updating” | Target time to usable | Agreed tolerance | Timed journey and previous result |
| --- | --- | --- | --- | --- | --- |
| TBD per screen | TBD | TBD | TBD | TBD | TBD |

### Where UI is verified

- Verify UI changes in CI or from preview artifacts, never by local runs or renders. This covers tests, lint, type checks, builds, screenshots, accessibility scans, speed measurements and sweep captures.
- When a check named in this file has no CI job yet, add the job to the workflow in the PR that relies on it.
- These checks named in this file have no CI job yet:
  - The ESLint configs in section 8 (Lint). No CI task runs ESLint. [#431](https://github.com/MasarX/masarx-platform/issues/431)
  - Accessibility of Console, Console V2 and portal screens: rendered contrast, tab order and 24 by 24 pixel targets. Landing E2E covers only landing and public tracking, and CI does not run `tests/e2e`. [#301](https://github.com/MasarX/masarx-platform/issues/301), [#270](https://github.com/MasarX/masarx-platform/issues/270)
  - Screen coverage and daily sweep captures of signed-in screens. Visual baselines run only on manual dispatch. [#432](https://github.com/MasarX/masarx-platform/issues/432)
  - Time to usable for Console V2 and portal screens (Speed). [#388](https://github.com/MasarX/masarx-platform/issues/388)

### Review and sweeps

- Have the Design lead run one daily sweep across roles, viewports, themes and states.
- File each finding as an issue and revert a change that breaks a critical user journey.
- Delegate the hands-on checks to a worker that reads the CI and preview artifacts and returns only the findings.
- Sweep signed-in screens on dev only with the [synthetic sweep accounts](DELIVERY.md#signed-in-dev-sweep) and keep credentials out of logs, captures and issues.
- Design changes, including UI, i18n, mockups, `DESIGN.md`, tests and sweep findings, get no review. The Design lead's thread opens each PR and merges it on green required CI. A change to which personal data a screen shows, or to whom, is high risk and gets one review under the engineering standard's high-risk rule.

### Changing this file

- Change every look-and-feel rule through a PR to `DESIGN.md` and use Git history as the change log.

## 10. Known gaps

2. Shared UI, Console V2 and landing use different palettes, type stacks, radii and theme storage keys. Only the shared provider follows live OS theme changes in system mode. `packages/ui/src/styles.css`, `packages/ui/src/theme.tsx`, `apps/console-v2/src/styles/tokens.css`, `apps/console-v2/src/lib/theme.tsx`, `docs/marketing/landing-v2/app.css`, `docs/marketing/landing-v2/app.js`.
6. Landing tracking styles reference `--c-ink`, `--c-muted` and `--line` without definitions in the loaded stylesheet. Other tracking rules contain local color literals. `docs/marketing/landing-v2/track.html`, `docs/marketing/landing-v2/app.css`.
7. Shared reduced-motion handling is selective. The table shimmer and motion-safe overlays respect it, while the shared button's loading spinner uses an unconditional spin utility. `packages/ui/src/styles.css`, `packages/ui/src/modal.tsx`, `packages/ui/src/button.tsx`. See also `docs/product/ux/i18n-rtl-a11y-requirements.md`.

See also `docs/product/ux/console-portal-ia-ux-spec.md`, `docs/product/ux/console-portal-page-matrix.md` and `docs/frontend/ARCHITECTURE.md`.
