// verify-routes.mjs — Playwright headless smoke test across every route in
// the routes directory. Total grows additively as Wave 1/2 claims land.
// Usage: npm run dev (in another terminal) then `node scripts/verify-routes.mjs`.
//
// Cold-start handling (W14-10 follow-up): Vite dev compilation can exceed a
// 15 s budget for the first few routes when sibling agents saturate the
// ports. We:
//   1. Run a single warm-up navigation (default `/`) with a longer budget so
//      the dev server has compiled the root React tree, route loader, and
//      shared chunks before the timed pass starts. The warm-up itself is
//      excluded from pass/fail accounting.
//   2. Use a per-route timeout that defaults to 30 s (overridable via
//      `VERIFY_ROUTE_TIMEOUT_MS`) so subsequent routes that still need
//      first-compile work do not flake.
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const readOption = (...names) => {
  for (const [index, arg] of argv.entries()) {
    for (const name of names) {
      if (arg === name) return argv[index + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
};

const BASE = readOption('--base-url', '--base', '--url') || process.env.VERIFY_BASE || 'http://localhost:5175';
const ROUTE_TIMEOUT_MS = Number(process.env.VERIFY_ROUTE_TIMEOUT_MS || 30000);
const WARMUP_TIMEOUT_MS = Number(process.env.VERIFY_WARMUP_TIMEOUT_MS || 60000);
const WARMUP_PATH = process.env.VERIFY_WARMUP_PATH || '/';

const ROUTES = [
  ['dashboard', '/'],
  ['op-route-plans', '/operate/route-plans'],
  ['op-dispatch', '/operate/dispatch'],
  ['op-shipments', '/operate/shipments'],
  ['op-baskets', '/operate/baskets'],
  ['op-amend-cancel', '/operate/amend-cancel'],
  ['op-exceptions', '/operate/exceptions'],
  ['op-returned-to-branch', '/operate/returned-to-branch'],
  ['op-pickups', '/operate/pickups'],
  ['op-tracking-map', '/operate/tracking-map'],
  ['op-fleet-drivers', '/operate/fleet/drivers'],
  ['op-fleet-driver-applications', '/operate/fleet/driver-applications'],
  ['op-fleet-vehicles', '/operate/fleet/vehicles'],
  // `/network/hubs` was deprecated in Phase G (subagent G2) and now redirects
  // to `/network/branches`; smoke-testing it would just re-cover the branches
  // route, so the entry is intentionally removed. Decision document:
  // apps/console-v2/__audit__/DECISIONS/HUBS.md.
  ['network-partners', '/network/partners'],
  ['network-geocoding', '/network/geocoding'],
  // CLAIM-NETWORK-BRANCHES (Wave 1, Phase A) — branch roster + capacity / coverage editor.
  ['network-branches', '/network/branches'],
  // CLAIM-NETWORK-ZONES (Wave 1, Phase A) — map-first zones surface.
  ['network-zones', '/network/zones'],
  // CLAIM-NETWORK-MARKETPLACE (Wave 2, Phase B) — operator marketplace surface.
  ['network-marketplace', '/network/marketplace'],
  // Phase D5 — non-driver marketplace participant pre-approval review queue.
  // Mirrors public.marketplace_participant_requests; routes Approve/Reject
  // through marketplace_participant_request_review_apply_v1.
  ['network-participant-applications', '/network/participant-applications'],
  ['customers-clients', '/customers/clients'],
  ['customers-senders', '/customers/senders'],
  ['customers-recipients', '/customers/recipients'],
  ['catalog-lookups', '/catalog/lookups'],
  // CLAIM-CATALOG-OFFERINGS (Wave 2, Phase B) — service catalog browser.
  ['catalog-service-offerings', '/catalog/service-offerings'],
  ['finance-settlements', '/finance/settlements'],
  ['finance-cod', '/finance/cod'],
  ['finance-ledger', '/finance/ledger'],
  ['finance-bank-recon', '/finance/bank-recon'],
  ['finance-disputes', '/finance/disputes'],
  // CLAIM-FINANCE-BILLING (Wave 2, Phase B) — operator billing/invoices surface.
  ['finance-billing', '/finance/billing'],
  ['wf-templates', '/workflows/templates'],
  ['wf-runs', '/workflows/runs'],
  ['wf-bindings', '/workflows/bindings'],
  ['wf-review-queue', '/workflows/review-queue'],
  ['int-catalog', '/integrations/catalog'],
  // INTEGRATIONS P0 (Wave 12 W12-2) — 4-stage authoring loop wired to the
  // `integration-plugin-studio` edge function (parse|infer|preview|save).
  ['int-plugin-studio', '/integrations/plugin-studio'],
  ['int-mapping', '/integrations/mapping'],
  ['int-health', '/integrations/health'],
  ['int-webhook-tester', '/integrations/webhook-tester'],
  ['int-credentials', '/integrations/credentials'],
  ['int-intake', '/integrations/intake'],
  ['int-sources', '/integrations/sources'],
  ['int-rules', '/integrations/rules'],
  ['insights-reporting', '/insights/reporting'],
  ['insights-decisions', '/insights/decisions'],
  ['insights-resolutions', '/insights/resolutions'],
  ['insights-traces', '/insights/traces'],
  ['insights-audit', '/insights/audit'],
  ['insights-ui-events', '/insights/ui-events'],
  ['insights-domain-events', '/insights/domain-events'],
  ['platform-config', '/platform/config'],
  ['platform-access', '/platform/access'],
  ['platform-organizations', '/platform/organizations'],
  ['platform-mobile-policy', '/platform/mobile-policy'],
  ['platform-labels', '/platform/labels'],
  ['platform-warehouse', '/platform/warehouse'],
  ['platform-imports', '/platform/imports'],
  ['platform-onboarding-readiness', '/platform/onboarding-readiness'],
  ['platform-auth-email', '/platform/auth-email'],
  ['platform-planning-os', '/platform/planning-os'],
  ['platform-release-proof', '/platform/release-proof'],
  ['platform-commands', '/platform/commands'],
  // CLAIM-PLATFORM-ALERTS (Wave 3, Phase C) — alerts management surface.
  ['platform-alerts', '/platform/alerts'],
  // CLAIM-PLATFORM-FLAGS (Wave 3, Phase C) — LaunchDarkly/Unleash/GrowthBook
  // parity feature-flag management surface.
  ['platform-feature-flags', '/platform/feature-flags'],
  // CLAIM-SUPPORT-CASES (Wave 3, Phase C) — Zendesk/Front/Linear-triage parity
  // 3-pane support cases triage surface.
  ['support-cases', '/support/cases'],
  // CLAIM-INSIGHTS-API-GW (Wave 3, Phase C) — Datadog APM/Honeycomb/Postman
  // parity API gateway observability surface.
  ['insights-api-gateway', '/insights/api-gateway'],
  // CLAIM-PLATFORM-USERS (Phase D4) — operator users admin surface (Grant
  // role / Revoke role / Suspend / Reactivate / Force password reset /
  // Revoke session). Mirrors public.users + public.user_sessions_v +
  // user_capability_eval_v1. Capability gates: users.read + users.manage.
  ['platform-users', '/platform/users'],
  // Legacy Console resource URLs must redirect into domain workbenches instead
  // of exposing raw database table routes.
  ['legacy-resource-shipments', '/console/resources/shipments?focus=SHP-1'],
  ['legacy-resource-workflow-templates', '/console/resources/workflow_templates'],
  ['legacy-resource-route-plans', '/console/resources/route_plans'],
  ['legacy-console-workflow-queue', '/console/workflows/queue'],
  ['legacy-console-workflow-templates', '/console/workflows/templates'],
  ['legacy-console-shipment-changes', '/console/operations/customer-shipment-changes'],
  ['legacy-console-exceptions', '/console/operations/exceptions/unassigned_exceptions'],
  ['legacy-console-provider-auth', '/console/integrations/provider-auth'],
  ['legacy-console-audit-logs', '/console/security/audit-logs'],
  ['legacy-console-label-designer', '/console/labels/designer'],
];

const NOISE = [
  /Download the React DevTools/i,
  /Vite is running in development mode/i,
  /TanStack/i,
  // The route smoke runner does not perform a Supabase login. In live-backend
  // mode, protected api-schema reads can emit browser console 401s while the
  // route shell still loads correctly; auth/data failures are covered by
  // dedicated integration tests.
  /Failed to load resource: the server responded with a status of 401 \(Unauthorized\)/i,
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  let pass = 0, fail = 0;
  const failures = [];

  // Cold-start warm-up: navigate once with a longer budget so Vite has
  // finished first-compile of the React tree + shared chunks before the
  // timed pass begins. The warm-up is not counted in pass/fail.
  process.stdout.write(`· Warming up dev server at ${BASE}${WARMUP_PATH} (timeout ${WARMUP_TIMEOUT_MS}ms)…\n`);
  try {
    await page.goto(`${BASE}${WARMUP_PATH}`, { waitUntil: 'load', timeout: WARMUP_TIMEOUT_MS });
    await page.waitForTimeout(750);
    process.stdout.write(`· Warm-up complete.\n\n`);
  } catch (e) {
    process.stdout.write(`· Warm-up navigation did not finish within ${WARMUP_TIMEOUT_MS}ms (${String(e.message).slice(0, 80)}); continuing with timed pass.\n\n`);
  }

  for (const [name, route] of ROUTES) {
    const errs = [];
    page.removeAllListeners('pageerror');
    page.removeAllListeners('console');
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const txt = m.text();
      if (NOISE.some((rx) => rx.test(txt))) return;
      errs.push(txt);
    });

    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'load', timeout: ROUTE_TIMEOUT_MS });
      await page
        .waitForFunction(
          () => !/Checking session/i.test(document.body.innerText),
          { timeout: 5000 },
        )
        .catch(() => {});
      await page.waitForTimeout(450);
      const html = await page.content();
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const charCount = html.length;
      if (/Page not found/i.test(bodyText)) {
        errs.push('Page not found rendered');
      }
      if (errs.length) {
        fail++;
        failures.push({ name, route, errs });
        process.stdout.write(`✗ ${name.padEnd(28)} ${charCount} chars · ${errs[0].slice(0, 80)}\n`);
      } else {
        pass++;
        process.stdout.write(`✓ ${name.padEnd(28)} ${charCount} chars\n`);
      }
    } catch (e) {
      fail++;
      failures.push({ name, route, errs: [e.message] });
      process.stdout.write(`✗ ${name.padEnd(28)} timeout/load failure: ${e.message.slice(0, 80)}\n`);
    }
  }

  await browser.close();
  console.log('\n──────────────────────────────────────');
  console.log(`PASS: ${pass} / ${ROUTES.length}`);
  if (fail) {
    console.log(`FAIL: ${fail}`);
    for (const f of failures) console.log(`  · ${f.name} ${f.route}\n     ${f.errs.join('\n     ')}`);
    process.exit(1);
  } else {
    console.log('All routes clean.');
  }
})();
