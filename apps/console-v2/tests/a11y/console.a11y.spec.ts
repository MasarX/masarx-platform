import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ROUTES: Array<[string, string]> = [
  ['Dashboard', '/'],
  ['Shipments', '/operate/shipments'],
  ['Workflow Studio', '/workflows/templates'],
  ['Workflow Runs', '/workflows/runs'],
  // W11-6 (CLAIM-WORKFLOWS-DEFERRED) — Triggers + Schedules sub-tabs surface
  // canonical workflow_run_triggers + workflow_schedule_triggers tables.
  // Tab state lives in the URL hash (?tab=triggers|schedules) so a11y is
  // exercised against the same DOM the operator sees.
  ['Workflow Run Triggers', '/workflows/runs?tab=triggers'],
  ['Workflow Schedules', '/workflows/runs?tab=schedules'],
  ['Review Queue', '/workflows/review-queue'],
  // CLAIM-E addition — bindings hardened condition builder.
  ['Workflow Bindings', '/workflows/bindings'],
  // W11-6 (CLAIM-WORKFLOWS-DEFERRED) — Dispatches sub-tab surfaces the
  // canonical workflow_binding_dispatches ledger.
  ['Workflow Binding Dispatches', '/workflows/bindings?tab=dispatches'],
  ['Settings', '/platform/config'],
  ['COD', '/finance/cod'],
  ['Decisions', '/insights/decisions'],
  ['Customers', '/customers/clients'],
  // CLAIM-I additions — webhook tester gained a tablist inspector; intake monitor renders policy chips.
  ['Webhook Tester', '/integrations/webhook-tester'],
  ['Intake Monitor', '/integrations/intake'],
  // CLAIM-INGRESS-COMPLETE additions — webhook_sources + webhook_rules surfaces.
  ['Webhook Sources', '/integrations/sources'],
  ['Routing Rules', '/integrations/rules'],
  // CLAIM-B additions — operator routing surfaces.
  ['Route Plans', '/operate/route-plans'],
  ['Dispatch', '/operate/dispatch'],
  ['Tracking Map', '/operate/tracking-map'],
  ['Baskets', '/operate/baskets'],
  // CLAIM-C additions — operator recovery surfaces (NDR queue + first-mile +
  // amend-cancel review queue + return-to-branch warehouse intake).
  ['Exceptions', '/operate/exceptions'],
  ['Pickups', '/operate/pickups'],
  ['Amend & Cancel', '/operate/amend-cancel'],
  ['Returned to Branch', '/operate/returned-to-branch'],
  // CLAIM-FLEET-DRIVERS (Wave 1, Phase A) — driver roster + 6-tab drawer.
  ['Fleet Drivers', '/operate/fleet/drivers'],
  ['Fleet Driver Applications', '/operate/fleet/driver-applications'],
  // CLAIM-FLEET-VEHICLES (Wave 1, Phase A) — fleet roster + 6-tab drawer.
  ['Fleet Vehicles', '/operate/fleet/vehicles'],
  // CLAIM-NETWORK-BRANCHES (Wave 1, Phase A) — branch roster + capacity/coverage editor.
  ['Network Branches', '/network/branches'],
  // CLAIM-NETWORK-ZONES (Wave 1, Phase A) — map-first split-view zones surface.
  ['Network Zones', '/network/zones'],
  // CLAIM-FINANCE-BILLING (Wave 2, Phase B) — billing/invoices surface +
  // multi-tab drawer (Lines / Backing usage events / Payment timeline /
  // Subscription source / Agreement terms).
  ['Finance Billing', '/finance/billing'],
  // CLAIM-CATALOG-OFFERINGS (Wave 2, Phase B) — service catalog grid + drawer.
  ['Catalog Service Offerings', '/catalog/service-offerings'],
  // CLAIM-NETWORK-MARKETPLACE (Wave 2, Phase B) — operator marketplace surface
  // (offers / awards / contracts / requests / reputation 5-tab single page).
  ['Network Marketplace', '/network/marketplace'],
  // Phase D5 — non-driver marketplace participant pre-approval review queue.
  // Mirrors public.marketplace_participant_requests; Approve/Reject routes
  // through marketplace_participant_request_review_apply_v1. Driver-typed
  // applications are owned by /operate/fleet/driver-applications.
  ['Network Participant Applications', '/network/participant-applications'],
  // CLAIM-PLATFORM-ALERTS (Wave 3, Phase C) — Datadog/PagerDuty/Sentry parity
  // alerts management surface (alert_rules + alert_triggers + ops_alerts).
  ['Platform Alerts', '/platform/alerts'],
  // CLAIM-PLATFORM-FLAGS (Wave 3, Phase C) — LaunchDarkly/Unleash/GrowthBook
  // parity feature-flag management surface (feature_flags table).
  ['Platform Feature Flags', '/platform/feature-flags'],
  ['Onboarding Readiness', '/platform/onboarding-readiness'],
  ['Release Proof', '/platform/release-proof'],
  // CLAIM-SUPPORT-CASES (Wave 3, Phase C) — Zendesk / Front / Linear-triage
  // parity 3-pane surface (queue / thread / customer profile + KPI strip).
  ['Support Cases', '/support/cases'],
  // CLAIM-INSIGHTS-API-GW (Wave 3, Phase C) — Datadog APM/Honeycomb/Postman
  // parity API gateway observability surface (api_call_log + api_gateway_*).
  ['Insights API Gateway', '/insights/api-gateway'],
  // CLAIM-PLATFORM-USERS (Phase D4) — operator users admin surface
  // (Grant/Revoke role + Suspend/Reactivate + Force password reset + Revoke
  // session). Mirrors public.users + user_sessions_v + user_capability_eval_v1.
  ['Platform Users', '/platform/users'],
];

for (const [name, route] of ROUTES) {
  test(`a11y: ${name} (${route})`, async ({ page }) => {
    // W14-10 — keep `waitUntil: 'load'` (it returns once subresources resolve
    // so SPA hydration is reliably done) but bump the per-page timeout so a
    // contended Vite cold-compile (multi-agent worktrees on the same host
    // share CPU/IO) does not abort before the page paints. Then wait for the
    // shell `<main>` landmark to ensure React has mounted the route.
    await page.goto(route, { waitUntil: 'load', timeout: 45_000 });
    await page
      .waitForSelector('main, [role="main"], [data-testid="app-shell"]', {
        state: 'attached',
        timeout: 15_000,
      })
      .catch(() => undefined);
    // Settle window for late-mounting child components (drawers, charts) and
    // post-hydration tab/query-param-driven re-renders.
    await page.waitForTimeout(1000);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      // `region` is a structural false-positive in our shell layout (statusbar/sidenav are landmarks
      // already; axe still flags content gaps inside sticky overlays). color-contrast is enabled.
      .disableRules(['region'])
      .analyze();
    const seriousOrCritical = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical'
    );
    if (seriousOrCritical.length) {
      console.log(`Violations on ${name}:`);
      for (const v of seriousOrCritical) {
        console.log(`  ${v.impact} · ${v.id}: ${v.description}`);
        for (const node of v.nodes.slice(0, 2)) console.log(`    target: ${node.target}`);
      }
    }
    expect(
      seriousOrCritical,
      `${seriousOrCritical.length} serious/critical violations on ${name}`
    ).toEqual([]);
  });
}
