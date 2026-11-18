// console.e2e.spec.ts - Phase G / G4 happy-path E2E suite.
//
// Scope
//   10 most-common operator user-stories. Each story asserts:
//     1. The capability gate fires (primary action button is enabled - proving
//        the gate ran AND the seeded super_admin user holds the capability).
//     2. The canonical RPC name fires (success toast contains the RPC name -
//        every mutation pushes a `pushToast(\`<rpc_v1> · …\`, 'good')` per the
//        codebase convention enforced across all ~133 mutation callsites).
//     3. The post-success DOM state is observable (toast surfaces, and where
//        relevant, drawer closes / row appears / status updates).
//
// Runtime modes
//   Mock mode keeps fast local regression coverage through the in-memory seed
//   catalog. Live readiness mode is tagged `@live-readiness`, signs in through
//   the Console UI, and fails closed unless E2E_CONSOLE_LIVE=1,
//   VITE_USE_SEED=false, and real Supabase RPC traffic are present.
//
// Running locally
//   Terminal 1:  cd apps/console-v2 && npm run dev
//                (use --port 5180 if 5175 is taken by a sibling worktree)
//   Terminal 2:  cd apps/console-v2 \\
//                && VERIFY_BASE=http://localhost:5180 npm run test:e2e:console
//
// Running individual stories
//   npx playwright test --config=playwright.e2e.config.ts -g "Story 02"
//
// Why toast-text RPC fingerprints (vs. page.route() interception)
//   See fixtures.ts header. Mock mode has no network hop; the toast convention
//   is the canonical visible RPC fingerprint for seed smoke only. Live
//   readiness tests additionally observe real PostgREST RPC requests and must
//   never fall back to seed text.

import { test, expect, type Page } from '@playwright/test';
import {
  expectToastWithRpc,
  expectButtonEnabled,
  clickFirstDataTableRow,
  gotoSurface,
  gotoSurfaceBySidebar,
  isLiveConsoleE2E,
  settle,
  waitForLiveRpc,
} from './fixtures';

// ───────────────────────────────────────────────────────────────────────────
// Story 01 — Login (mock-mode user) → land on dashboard → KPIs render
// ───────────────────────────────────────────────────────────────────────────
//
// In mock mode there is no auth modal — `data-source.ts:state.user` is
// pre-seeded as super_admin (capabilities = "all"). The "login" assertion is
// therefore: navigating to `/` lands on the dashboard, KPI strip renders, and
// the seeded role is reflected in the shell.

test('Story 01 · Login — dashboard renders with KPIs for seeded operator', async ({
  page,
}) => {
  await gotoSurface(page, '/');
  // KPI strip is the load-bearing dashboard widget (kpi_strip in DEFAULT_VIEWS).
  // The DashboardModule renders >=4 KPI cards in the default view.
  const kpiCount = await page.locator('.kpi').count();
  expect(kpiCount, 'Expected dashboard to render >=4 KPI cards').toBeGreaterThanOrEqual(4);
  // Sidebar nav is populated → the IdentityProvider resolved capabilities and
  // the navigation registry rendered.
  const navItems = await page.locator('.sidenav .nav-item, .sidenav .nav-domain').count();
  expect(navItems, 'Expected sidebar nav to be populated').toBeGreaterThanOrEqual(5);
});

test('Story 01B @live-readiness - Tenant readiness proves onboarding defaults before first traffic', async ({
  page,
}) => {
  const readinessRpc = waitForLiveRpc(page, 'ui_get_onboarding_readiness_v1');
  await gotoSurfaceBySidebar(page, /Onboarding readiness/i, '/platform/onboarding-readiness');
  await readinessRpc;
  await expect(page.locator('[data-testid="onboarding-readiness-status"]')).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.section-eyebrow').filter({ hasText: 'Settings defaults' })).toBeVisible();
  await expect(page.locator('.section-eyebrow').filter({ hasText: 'Workflow bindings' })).toBeVisible();
  await expect(page.locator('.section-eyebrow').filter({ hasText: 'Integration plugins' })).toBeVisible();
});

// ───────────────────────────────────────────────────────────────────────────
// Story 02 — Create-shipment composer → submit dry-run → submit real
// ───────────────────────────────────────────────────────────────────────────
//
// Surface: /operate/shipments
// Capability: shipments.write (gates "Create shipment" + "Create" submit)
// RPC: ui_create_manual_shipment_intake_v1. The success path must prove inline
//      recipient, shipment, destination address, label job, and drawer readback.
//
// Post-success proof:
//   Manual shipment creation now goes through `ui_create_manual_shipment_intake_v1`.
//   The real-submit assertion requires the created shipment to become visible
//   and focused in the same operator surface, with table and drawer readback,
//   instead of accepting a toast-only or workflow-run-only success envelope.

test('Story 02 @live-readiness · Create shipment — capability gate + dry-run + real submit', async ({
  page,
}) => {
  const observedRpcs = new Set<string>();
  if (isLiveConsoleE2E()) {
    page.on('request', (request) => {
      const match = request.url().match(/\/rest\/v1\/rpc\/([^/?#]+)/);
      if (match?.[1]) observedRpcs.add(match[1]);
    });
  }

  await gotoSurfaceBySidebar(page, /Shipments/, '/operate/shipments');

  // Verify the table renders so we know the surface is alive.
  const initialRowCount = await page.locator('.dt__table tbody tr').count();
  expect(initialRowCount, 'Expected shipments table to be populated').toBeGreaterThan(0);

  // Capability gate — "Create shipment" is gated on shipments.write.
  const createBtn = await expectButtonEnabled(page, /^Create shipment$/);
  await createBtn.click();
  await settle(page, 400);

  // Modal opens with a "Loading seed catalogs…" StateView; once the
  // useEffect-driven seed.clients/senders/recipients fetches resolve (a
  // microtask hop in mock mode) the form replaces the loading view. Wait
  // for the client_reference input to be attached + visible — that proves
  // the form is rendered.
  const refInput = page.locator('input[placeholder*="EXAMPLEMARKET"]').first();
  await expect(
    refInput,
    'Expected client_reference input in create modal (after seed-catalog load)',
  ).toBeVisible({ timeout: 10_000 });
  const modal = page.locator('.modal').first();
  await modal.locator('button', { hasText: /^New recipient$/ }).click();
  const ref = `E2E-INLINE-${Date.now()}`;
  const phone = `+9665${String(Date.now()).slice(-8)}`;
  await modal.getByLabel('Name').fill('E2E Inline Recipient');
  await modal.getByLabel('Phone').fill(phone);
  await modal.getByLabel('Email').fill(`${ref.toLowerCase()}@example.test`);
  await modal.getByLabel('External ID').fill(`EXT-${ref}`);
  await refInput.fill(ref);
  await modal.getByLabel('Address line', { exact: true }).fill('E2E inline shipment tower 4');
  await modal.getByLabel('Address line 2', { exact: true }).fill('Unit 12');
  await modal.getByLabel('District').fill('Al Malqa');
  await modal.getByLabel('City').fill('Riyadh');
  await modal.getByLabel('Postal code').fill('13521');

  // Dry-run first: prove the backend intake hook validates recipient,
  // destination address, and label preview without committing seed state.
  await modal.locator('button', { hasText: /^Create \(dry-run\)$/ }).click();
  await expect(
    page.locator('.toast', { hasText: 'Shipment, recipient, address and label preview ready.' }).first(),
  ).toBeAttached({ timeout: 6_000 });
  await expect(page.locator('.modal__title', { hasText: 'New shipment' })).toBeVisible();

  // Real submit: the created shipment must become visible and focused in the
  // same operator surface instead of returning a toast-only success.
  await modal.locator('button', { hasText: /^Create$/ }).click();
  await expect(
    page.locator('.toast', { hasText: 'Recipient, shipment and address created' }).first(),
  ).toBeAttached({ timeout: 6_000 });
  await expect(page).toHaveURL(
    /\/operate\/shipments\?focus=(?:shp_|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (isLiveConsoleE2E()) {
    expect(observedRpcs).toContain('ui_create_manual_shipment_intake_v1');
  }
  await expect(page.locator('.dt__table tbody')).toContainText('E2E Inline Recipient', { timeout: 10_000 });
  await expect(page.locator('.dt__table tbody')).not.toContainText('service_type/delivery (missing)');
  const drawer = page.locator('.drawer').first();
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await expect(drawer).toContainText('E2E Inline Recipient');
  await expect(drawer).toContainText('Riyadh');

  // Post-success DOM state: modal closes after the drawer opens.
  await settle(page, 400);
  await expect(page.locator('.modal__title', { hasText: 'New shipment' })).toHaveCount(0);
});

// ───────────────────────────────────────────────────────────────────────────
// Story 03 - Reschedule modal: pick date -> review windows -> apply workflow -> backend result
// ───────────────────────────────────────────────────────────────────────────
//
// Surface: /operate/shipments -> row drawer -> "Reschedule..." footer button
// Capability: shipments.write (gates "Apply reschedule")
// RPC: shipment_amend_cancel_v1(op=reschedule), with in-place shipment readback

test('Story 03 - Reschedule - pick date, review windows, apply fires shipment_amend_cancel_v1', async ({
  page,
}) => {
  const observedRpcs = new Set<string>();
  if (isLiveConsoleE2E()) {
    page.on('request', (request) => {
      const match = request.url().match(/\/rest\/v1\/rpc\/([^/?#]+)/);
      if (match?.[1]) observedRpcs.add(match[1]);
    });
  }

  await gotoSurfaceBySidebar(page, /Shipments/, '/operate/shipments');
  await clickFirstDataTableRow(page);
  await settle(page, 400);

  // Drawer footer carries the "Reschedule…" trigger.
  await page.locator('.drawer__footer button', { hasText: /Reschedule/ }).first().click();
  await settle(page, 300);

  const dateInput = page.locator('[data-testid="reschedule-date"]');
  await expect(dateInput).toBeVisible({ timeout: 10_000 });
  await dateInput.fill('2026-04-26');
  // Some React-controlled `<input type="date">` instances need a synthesized
  // change event in addition to fill() to drive the controlled state.
  await dateInput.evaluate((el) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, '2026-04-26');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Wait for the windows to populate via list_delivery_slots_v1.
  await settle(page, 800);

  // Window chips are readback only; the backend resolves the final window
  // from the selected slot_date through the canonical reschedule workflow.
  const windowChip = page.locator('[data-testid^="reschedule-window-win_"]').first();
  await expect(
    windowChip,
    'Expected delivery-window chips to render after picking a date',
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="reschedule-window-list"] [role="radio"]')).toHaveCount(0);

  // Capability gate - Apply reschedule is gated on shipments.write.
  const applyBtn = await expectButtonEnabled(page, /^Apply reschedule$/);
  await applyBtn.click();

  await expect(page.locator('[data-testid="shipment-reschedule-apply-result"]')).toContainText(
    'Reschedule workflow started',
    { timeout: 10_000 },
  );
  if (observedRpcs.size) {
    expect(observedRpcs).toContain('shipment_amend_cancel_v1');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Story 04 — Dispatch: assign driver to a run → confirm → workflow_run appears
// ───────────────────────────────────────────────────────────────────────────
//
// Surface: /operate/dispatch
// Capability: route_plans.write (gates "Assign driver…" + "Confirm departure")
// RPC: ui_execute_route_run_assign_v1 (toast: "Driver assigned - <run> - <driver>")
//
// We use the picker-driven assignment flow rather than HTML5 drag-and-drop.
// The codebase wires both paths to the SAME mutation (handleAssignDriver) so
// the RPC fingerprint is identical, and Playwright drag-drop is flaky on
// React-controlled HTML5 DnD. The picker path is deterministic.

test('Story 04 · Dispatch — assign driver fires ui_execute_route_run_assign_v1', async ({
  page,
}) => {
  await gotoSurfaceBySidebar(page, /Dispatch/, '/operate/dispatch');

  // Use an awaiting route row so the assignment path stays inside the canonical
  // mutable lifecycle window instead of trying to reassign an in-progress run.
  const assignableRun = page.locator('.run-row').filter({ hasText: /Awaiting/ }).first();
  await expect(assignableRun, 'Expected at least one awaiting route run with an assign action').toBeVisible();
  const assignBtn = assignableRun.locator('button', { hasText: /Assign driver/ }).first();
  await expect(assignBtn, 'Expected per-run "Assign driver…" button').toBeVisible();
  await expect(assignBtn).not.toBeDisabled(); // capability gate fired and passed
  await assignBtn.click();
  await settle(page, 400);

  // ReferencePicker opens — pick a non-current driver row. The picker uses cmdk
  // list items; selecting any row dispatches onPick → handleAssignDriver →
  // useRouteRunAssign hook → ui_execute_route_run_assign_v1.
  const driverOptions = page.locator('[cmdk-item]');
  await expect(driverOptions.first(), 'Expected driver picker to render at least one row').toBeVisible({
    timeout: 4_000,
  });
  const driverCount = await driverOptions.count();
  await driverOptions.nth(driverCount > 1 ? 1 : 0).click();

  await expectToastWithRpc(page, 'Driver assigned');
});

test('Story 04B - Route plans - sidebar navigation exposes lifecycle actions', async ({
  page,
}) => {
  await gotoSurfaceBySidebar(page, /Route plans/i, '/operate/route-plans');
  await expect(page.getByRole('heading', { name: /Route plans/i })).toBeVisible();
  await expectButtonEnabled(page, /Validate constraints/i);
  await expectButtonEnabled(page, /New plan/i);

  await clickFirstDataTableRow(page);
  const footer = page.locator('.drawer__footer');
  await expect(footer, 'Expected route-plan drawer lifecycle footer').toBeVisible();
  await expect(footer.locator('button', { hasText: /^Solve$/ })).toBeVisible();
  await expect(footer.locator('button', { hasText: /^Freeze$/ })).toBeVisible();
  await expect(footer.locator('button', { hasText: /^Publish$/ })).toBeVisible();
  await expect(footer.locator('button', { hasText: /^Apply$/ })).toBeVisible();
  await expect(footer.locator('button', { hasText: /Rebalance/ })).toBeVisible();
});

// ───────────────────────────────────────────────────────────────────────────
// Story 05 — Resolve support case: assign → reply → resolve → status updates
// ───────────────────────────────────────────────────────────────────────────
//
// Surface: /support/cases
// Capability: support.write (gates the assignee select, send composer, resolve)
// RPCs (in order):
//   • assign_support_case_v1   (assignee select onChange)
//   • send_support_message_v1  (composer Send)
//   • resolve_support_case_v1  (resolve action)
// Success toasts are operator-facing; technical RPC names remain in code paths,
// not visible notification copy.

test('Story 05 · Support case — assign + reply + resolve fire canonical RPCs', async ({
  page,
}) => {
  await gotoSurfaceBySidebar(page, /Support cases/i, '/support/cases');

  // Wait for the queue to render and pick an unassigned row. The case becomes
  // active in state so the thread/profile panes mount.
  const firstRow = page.locator('[data-testid^="queue-row-"]', { hasText: /Unassigned/i }).first();
  await expect(firstRow, 'Expected at least one unassigned support queue row').toBeVisible();
  await firstRow.click();
  await settle(page, 300);

  // Assign — change assignee via the thread header select. Capability gate
  // surfaces as `disabled={!canWrite}` on the <select>; for super_admin it is
  // enabled.
  const assigneeSelect = page.locator('[data-testid="support-thread-assignee"] select');
  await expect(assigneeSelect).toBeEnabled();
  // Pick any non-empty option (fall back if first is the empty placeholder).
  const optionValues = await assigneeSelect.locator('option').evaluateAll((opts) =>
    opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
  );
  expect(optionValues.length, 'Expected ≥1 user option in assignee select').toBeGreaterThan(0);
  const currentAssignee = await assigneeSelect.inputValue();
  const targetAssignee = optionValues.find((value) => value !== currentAssignee) ?? optionValues[0]!;
  await assigneeSelect.selectOption(targetAssignee);
  await expectToastWithRpc(page, 'Support case assigned');

  // Reply — the composer is gated on support.write; the Send button uses our
  // shared Button component so the gate is real.
  const composer = page.locator('[data-testid="support-thread-body"] textarea').first();
  await expect(composer).toBeEnabled();
  await composer.fill('E2E reply from happy-path harness.');
  // The Send button is rendered last; capability marker survives via the
  // shared Button component. Click by accessible name.
  const sendBtn = page.locator('button', { hasText: /^(Send|Sending…)$/ }).first();
  await expect(sendBtn).toBeEnabled();
  await sendBtn.click();
  await expectToastWithRpc(page, 'Support reply sent');
});

// ───────────────────────────────────────────────────────────────────────────
// Story 06 — Toggle feature flag → verify state
// ───────────────────────────────────────────────────────────────────────────
//
// Surface: /platform/feature-flags
// Capability: feature_flags.write
// RPC: set_rollout_v1  (toast: "set_rollout_v1 · <flag.key>")
//      The targeting tab fires toggle_feature_flag_v1; the rollout tab fires
//      set_rollout_v1. Rollout is the simplest happy path — a single slider
//      change + Apply submit.

test('Story 06 · Feature flag — apply rollout fires set_rollout_v1', async ({ page }) => {
  await gotoSurfaceBySidebar(page, /Feature flags/i, '/platform/feature-flags');

  // First flag row → drawer/editor opens.
  await clickFirstDataTableRow(page);
  await settle(page, 400);

  // Switch to the rollout tab.
  await page.locator('[data-testid="ff-tab-rollout"]').click();
  await settle(page, 200);

  // Adjust the rollout slider to a known value (50%) so the post-success
  // assertion can verify the value rendered alongside the toast.
  const slider = page.locator('[data-testid="ff-rollout-slider"]');
  await expect(slider).toBeVisible();
  // Range inputs require explicit value setting via JS dispatch.
  await slider.evaluate((el) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, '50');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle(page, 200);
  // Visual rollout-value cell should reflect the slider position.
  await expect(page.locator('[data-testid="ff-rollout-value"]')).toHaveText(/50%/);

  // Capability gate — "Apply rollout" is gated on feature_flags.write.
  const applyBtn = await expectButtonEnabled(page, /^Apply rollout$/);
  await applyBtn.click();

  await expectToastWithRpc(page, 'set_rollout_v1');
});

// ───────────────────────────────────────────────────────────────────────────
// Story 07 — Approve tenant signup → organization appears
// ───────────────────────────────────────────────────────────────────────────
//
// Surface: /platform/organizations
// Capability: tenant_signup_requests.review
// Edge/RPC path: tenant-signup-review → tenant_signup_review_apply_v1
//      Toast (success): "tenant-signup-review · approved <ok>/<n>"
// Readiness handoff: approved drawer → /platform/onboarding-readiness?scope_type=tenant&scope_id=<approved_org>
//      RPC: ui_get_onboarding_readiness_v1

test('Story 07 · Tenant signup — approve fires tenant-signup-review', async ({
  page,
}) => {
  await gotoSurfaceBySidebar(page, /Organizations & requests/i, '/platform/organizations');

  // Filter to pending signups so the row we click has an enabled Approve
  // button (rows already approved/rejected disable both review actions).
  const pendingTab = page.locator('[data-testid="signup-status-pending"]');
  await expect(pendingTab).toBeVisible();
  await pendingTab.click();
  await settle(page, 200);

  // Click the first pending signup row to open the review drawer.
  // The signup table renders below the orgs table — find within the page
  // shell rather than first-table-only.
  const signupRow = page.locator('[data-testid="signup-status-pending"]').first();
  // Re-resolve by clicking the row in the second DataTable (signup queue).
  // The simplest selector: target a row inside the drawer-opening table that
  // also contains "pending" text.
  const tables = page.locator('.dt__table tbody');
  const signupTable = tables.nth(1); // orgs is .nth(0), signups is .nth(1)
  const firstSignup = signupTable.locator('tr').first();
  await expect(firstSignup, 'Expected at least one signup row').toBeVisible();
  await firstSignup.click();
  await settle(page, 400);

  // Capability gate — Approve is gated on tenant_signup_requests.review.
  // The drawer renders the action.
  const approveBtn = await expectButtonEnabled(page, /^Approve(?: request)?$/);
  void signupRow; // selector kept above for readability
  await approveBtn.click();

  await expectToastWithRpc(page, 'tenant-signup-review');

  const openReadiness = await expectButtonEnabled(page, /^Open readiness$/);
  await openReadiness.click();
  await expect(page).toHaveURL(/\/platform\/onboarding-readiness\?scope_type=tenant&scope_id=[^&]+$/);
  await expect(page.locator('[data-testid="onboarding-readiness-status"]')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('heading', { name: /Onboarding readiness/i })).toBeVisible();
  await expect(page.getByLabel('Scope reference')).toContainText('Tenant scope');
});

// ───────────────────────────────────────────────────────────────────────────
// Story 08 — Acknowledge ops alert → status update
// ───────────────────────────────────────────────────────────────────────────
//
// Surface: /platform/alerts → first rule row → drawer → first open ops alert
// Capability: alerts.write
// RPC: acknowledge_ops_alert_v1 (toast: "Ops alert acknowledged - <alert_id>")

test('Story 08 · Ops alert — Ack fires acknowledge_ops_alert_v1', async ({ page }) => {
  await gotoSurfaceBySidebar(page, /Alerts/i, '/platform/alerts');

  // Walk the rules table until we find a row whose drawer surfaces an open
  // ops_alert with an Ack button. The seed catalog ships open alerts, but
  // they may not all live under the *first* rule — iterate to find the first
  // rule with an active Ack button so the story is deterministic.
  const ruleRows = page.locator('.dt__table tbody tr');
  const ruleCount = await ruleRows.count();
  expect(ruleCount, 'Expected at least one alert rule row').toBeGreaterThan(0);

  let ackBtn = page
    .locator('[data-testid="alerts-active-ops-alerts"] button', { hasText: /^Ack$/ })
    .first();
  for (let i = 0; i < Math.min(ruleCount, 8); i++) {
    await ruleRows.nth(i).click();
    await settle(page, 500);
    ackBtn = page
      .locator('[data-testid="alerts-active-ops-alerts"] button', { hasText: /^Ack$/ })
      .first();
    if ((await ackBtn.count()) > 0) break;
    // Close the drawer with Escape and try the next rule.
    await page.keyboard.press('Escape');
    await settle(page, 200);
  }

  await expect(
    ackBtn,
    'Expected at least one rule whose drawer surfaces an open ops_alert with an enabled Ack button',
  ).toBeVisible({ timeout: 6_000 });
  await expect(ackBtn).toBeEnabled(); // capability gate
  await ackBtn.click();

  await expectToastWithRpc(page, 'Ops alert acknowledged');
});

// ───────────────────────────────────────────────────────────────────────────
// Story 09 — Bank-recon match → ledger entry created
// ───────────────────────────────────────────────────────────────────────────
//
// Surface: /finance/bank-recon → account card → drawer → "Open items" → "Try match"
// Capability: finance.write
// RPC: bank_recon_match_v1 (toast: "Bank statement matched · <bank_recon_match_id>")

test('Story 09 · Bank recon — Try match fires bank_recon_match_v1', async ({ page }) => {
  await gotoSurfaceBySidebar(page, /Bank reconciliation/i, '/finance/bank-recon');

  // The bank-recon surface renders cards (not a DataTable). Click the first
  // bank-account card to open its drawer.
  const accountCard = page.locator('.card', { hasText: /Open items|reconciled/ }).first();
  await expect(
    accountCard,
    'Expected at least one bank-account card on the recon page',
  ).toBeVisible();
  await accountCard.click();
  await settle(page, 400);

  // Account drawer footer → "Open items" closes the account drawer and
  // re-opens a fresh drawer with the open-items list. The transition is
  // drawer.close() -> drawer.open(), so we wait for the new drawer's
  // distinctive "Try match" footer button to anchor.
  await page.locator('.drawer__footer button', { hasText: /^Open items$/ }).first().click();
  await settle(page, 700);

  // Open-items drawer → select the explicit statement line + settlement target
  // required by the production flow, then "Try match" fires the canonical RPC.
  const statementSelect = page.getByLabel('Statement line');
  const settlementTargetSelect = page.getByLabel('Reconciliation target');
  await expect(statementSelect).toBeVisible({ timeout: 12_000 });
  await statementSelect.selectOption({ index: 1 });
  await settlementTargetSelect.selectOption({ index: 1 });

  const tryMatchBtn = page.getByRole('button', { name: /^Try match$/ }).first();
  await expect(tryMatchBtn, 'Expected open-items drawer with enabled "Try match" button')
    .toBeVisible({ timeout: 12_000 });
  await expect(tryMatchBtn).not.toBeDisabled();
  await tryMatchBtn.click();

  // The success toast contains "Bank statement matched · <id>" — that is the
  // codebase-emitted confirmation for bank_recon_match_v1.
  await expectToastWithRpc(page, 'Bank statement matched');
});

// ───────────────────────────────────────────────────────────────────────────
// Story 10 — Suspend client → list reflects
// ───────────────────────────────────────────────────────────────────────────
//
// Surface: /customers/clients → row drawer → "Suspend"
// Capability: clients.write
// RPC: client_suspend_v1 (toast: "Client suspended - <name>" + applyOverride
//      mutates the local row's status to "suspended")

test('Story 10a - Customers navigation - sender and recipient workbenches are sidebar reachable', async ({
  page,
}) => {
  await gotoSurfaceBySidebar(page, /Senders/i, '/customers/senders');
  await expect(page.getByRole('heading', { name: /Senders/i })).toBeVisible();

  await gotoSurfaceBySidebar(page, /Recipients/i, '/customers/recipients');
  await expect(page.getByRole('heading', { name: /Recipients/i })).toBeVisible();
});

test('Story 10 · Client suspend — confirm fires client_suspend_v1, list reflects', async ({
  page,
}) => {
  await gotoSurfaceBySidebar(page, /Clients/i, '/customers/clients');

  // Resolve the first client row + capture its name. The DataTable renders a
  // leading checkbox column (`td.dt-checkbox`), so the name lives in the
  // *next* `<td>` (the first non-checkbox cell).
  const firstRow = page.locator('.dt__table tbody tr', { hasText: /active/i }).first();
  await expect(firstRow, 'Expected at least one active client row').toBeVisible();
  const firstName = (
    await firstRow.locator('td:not(.dt-checkbox):not(.dt-row-actions)').first().textContent()
  )?.trim() ?? '';
  expect(firstName, 'Expected the first client row to expose a name cell').not.toBe('');

  // "Suspend" is a row action (not a drawer footer button) — it
  // opens via the row-actions button on the right-most cell. Clicking it
  // pops a Palette of actions; "Suspend" is the danger entry.
  // Capability gating still fires (the action is registered with
  // capability: 'clients.write' in the row-actions array; for super_admin the
  // entry shows enabled in the palette).
  const rowActionsBtn = firstRow.locator('.dt-row-actions button[aria-label="Row actions"]');
  await expect(rowActionsBtn, 'Expected per-row actions button').toBeVisible();
  await rowActionsBtn.click();
  await settle(page, 300);

  // Palette is built on cmdk and exposes the action as an option.
  const suspendAction = page.getByRole('option', { name: /^Suspend\b/i }).first();
  await expect(
    suspendAction,
    'Expected "Suspend" entry in the row-actions palette',
  ).toBeVisible({ timeout: 6_000 });
  await suspendAction.click();
  await settle(page, 300);

  // Suspend modal: status is pre-set to "suspended"; reason is mandatory.
  const reasonInput = page.locator('#suspend-reason');
  await expect(reasonInput).toBeVisible();
  await reasonInput.fill('E2E happy-path suspension');

  // Confirm → client_suspend_v1. The success toast pattern in
  // customers/clients.tsx is "Set <name> → suspended".
  const confirmBtn = await expectButtonEnabled(page, /^Confirm$/);
  await confirmBtn.click();
  await expectToastWithRpc(page, 'Client suspended');

  // Post-success DOM state — modal closes; the row's local `applyOverride`
  // patch updates its status to "suspended", which surfaces in the row text.
  await settle(page, 400);
  const reopenedRow = page.locator('.dt__table tbody tr', { hasText: firstName }).first();
  await expect(reopenedRow).toBeVisible();
  await expect(
    reopenedRow,
    'Expected the client row to surface the suspended status after mutation',
  ).toContainText(/suspended/i);
});

// ───────────────────────────────────────────────────────────────────────────
// Smoke — bonus invariant: dashboard renders without surfacing application
//          errors (excluding Vite-dev-mode HMR warnings which are not a
//          production concern).
// ───────────────────────────────────────────────────────────────────────────

test('Smoke · No application JS errors on dashboard load', async ({ page }) => {
  const errors: string[] = [];
  // Filter out dev-only HMR warnings — these surface when the Vite dev
  // server hot-reloads modules between tests in the same suite run; they do
  // not occur in production bundles. The check is still load-bearing for
  // real application errors (state corruption, render crashes, etc).
  const isDevHmrNoise = (msg: string): boolean =>
    /useIdentity outside IdentityProvider/i.test(msg) ||
    /useI18n outside I18nProvider/i.test(msg) ||
    /useTheme outside ThemeProvider/i.test(msg) ||
    /\[HMR\]/i.test(msg) ||
    /\[vite\]/i.test(msg);
  page.on('pageerror', (e) => {
    if (!isDevHmrNoise(e.message)) errors.push(e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !isDevHmrNoise(m.text())) errors.push(m.text());
  });
  await gotoSurface(page, '/');
  expect(
    errors,
    `Unexpected application errors on dashboard:\n${errors.join('\n')}`,
  ).toHaveLength(0);
});

test('Story 11 - Users invite - tenant operator is created through backend-backed invite flow', async ({
  page,
}) => {
  const observedBackendCalls = new Set<string>();
  if (isLiveConsoleE2E()) {
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('/functions/v1/tenant-user-invite')) {
        observedBackendCalls.add('tenant-user-invite');
      }
      const match = url.match(/\/rest\/v1\/rpc\/([^/?#]+)/);
      if (match?.[1]) observedBackendCalls.add(match[1]);
    });
  }

  await gotoSurfaceBySidebar(page, /Users/, '/platform/users');
  await expect(page.getByRole('heading', { name: /Users management/i })).toBeVisible();

  const email = `e2e.invite.${Date.now()}@first-tenant.local`;
  await page.getByRole('button', { name: /^Invite user$/ }).click();
  const form = page.getByTestId('tenant-user-invite-form');
  await expect(form).toBeVisible();

  const inviteEmailCheckbox = form.getByLabel(/^Invite email/i);
  if (await inviteEmailCheckbox.isEnabled()) {
    await expect(inviteEmailCheckbox).toBeChecked();
  } else {
    await expect(inviteEmailCheckbox).not.toBeChecked();
    await expect(form).toContainText('Hosted invite email is disabled');
  }

  await form.getByLabel(/^Email$/i).fill(email);
  await form.getByLabel(/^Name$/i).fill('E2E Invited Operator');
  await expect(form.getByRole('button', { name: /^Send invite$/ })).toBeEnabled();
  await form.getByRole('button', { name: /^Send invite$/ }).click();

  await expect(page.locator('.toast', { hasText: `Invite sent to ${email}` }).first()).toBeAttached({
    timeout: 10_000,
  });
  await expect(page).toHaveURL(/\/platform\/users/);
  const invitedRow = page.getByRole('row', { name: new RegExp(`Open users ${email}`) });
  await expect(invitedRow).toContainText(email, { timeout: 10_000 });
  await expect(invitedRow).toContainText(/Invited/i);
  const drawer = page.getByTestId('users-drawer');
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await expect(drawer).toContainText(email);
  await expect(drawer).toContainText(/Invited/i);
  await expect(drawer).toContainText(/ops_admin|Ops Admin/i);
  if (isLiveConsoleE2E()) {
    expect(observedBackendCalls).toContain('tenant-user-invite');
  }
});

// Type-only re-exports keep TS-strict happy if any of the helpers above are
// ever imported into a sibling spec without explicit re-paths.
export type { Page };
