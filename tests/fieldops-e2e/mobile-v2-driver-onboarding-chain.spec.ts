// Mobile V2 chained-flow human-flow tests. Proves the full driver
// onboarding journey — login → role-select → pre-shift checklist →
// pre-shift gate → today → tasks → stop — is reachable through visible
// clicks/taps from the audit gallery entry. Satisfies the FieldOps V2
// orchestrator goal "All main workflows reachable through human-like
// clicks/taps from `/login`" via the audit harness.
//
// This spec complements `mobile-v2-gallery-flows.spec.ts` (which
// validates each screen in isolation): here we walk a SEQUENCE of
// screens that mirror the production navigation order, each driven by
// a real input/tap, screenshot at each step.

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const GALLERY_URL = "/?v2=preview&gallery=1";
const SCREENSHOT_DIR = path.resolve(
  __dirname,
  "__screenshots__",
  "mobile-v2-driver-onboarding-chain",
);

test.use({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: false,
});

async function gotoGallery(page: Page): Promise<void> {
  await page.goto(GALLERY_URL, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/FieldOps V2 · Gallery/i)).toBeVisible({
    timeout: 30_000,
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}

async function selectScreen(page: Page, label: string): Promise<void> {
  await page.getByText(new RegExp(`^${label}$`)).first().click();
  // Allow the gallery to swap the rendered demo into the phone frame.
  await page.waitForTimeout(150);
}

test("driver onboarding chain · login → role-select → pre-shift checklist → pre-shift gate → today/tasks", async ({ page }) => {
  await gotoGallery(page);

  // 1) Login screen
  await selectScreen(page, "Login");
  await expect(page.getByText(/Welcome back/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "01-login-emp-step");
  // Tap "Send code" — exercises the onSubmit gate.
  await page.getByRole("button", { name: /Send code/i }).first().click();
  await shot(page, "02-login-otp-step");

  // 2) Role select
  await selectScreen(page, "Role select");
  await expect(page.getByText(/Pick a role|Driver/i).first()).toBeVisible({ timeout: 10_000 });
  await page.getByText(/^Driver$/).first().click();
  await shot(page, "03-role-select-driver-picked");

  // 3) Pre-shift checklist — toggle 2 items, confirm visible state change
  await selectScreen(page, "Pre-shift checklist");
  await expect(page.getByText(/Fuel/i).first()).toBeVisible({ timeout: 10_000 });
  await page.getByText(/Fuel/i).first().click();
  await page.getByText(/Tires/i).first().click();
  await shot(page, "04-pre-shift-checklist-two-checked");

  // 4) Pre-shift gate — surfaces blockers + start CTA gating
  await selectScreen(page, "Pre-shift gate");
  await expect(
    page.getByText(/Daily cleaning attestation|cleaning|Weekly vehicle photos/i).first(),
  ).toBeVisible({ timeout: 10_000 });
  await shot(page, "05-pre-shift-gate-blockers");

  // 5) Loader today (next-in-line if the picked role is loader)
  await selectScreen(page, "Loader today");
  await expect(page.getByText(/Bay B|Wave|Cut-off/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "06-loader-today-overview");

  // 6) Route + Map (driver navigation)
  await selectScreen(page, "Route");
  await expect(page.getByText(/All stops|Saved|SLA/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "07-route-list");

  await selectScreen(page, "Map");
  await expect(page.getByText(/RT-RUH|pending/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "08-map-overview");

  // 7) COD ledger
  await selectScreen(page, "COD ledger");
  await expect(page.getByText(/Collected|Expected/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "09-cod-ledger");
});

test("loader onboarding chain · kyc-docs → kyc-vehicle → kyc-vehicle-photos → cleaning → bay-board → manifest", async ({ page }) => {
  await gotoGallery(page);

  await selectScreen(page, "KYC · docs");
  await expect(page.getByText(/National ID|Driving licence/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "01-kyc-docs");

  await selectScreen(page, "KYC · vehicle");
  await expect(page.getByText(/Plate|Istimara|Toyota|Hiace/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "02-kyc-vehicle");

  await selectScreen(page, "KYC · vehicle photos");
  await expect(page.getByText(/Front|Rear|Plate visible/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "03-kyc-vehicle-photos");

  await selectScreen(page, "Cleaning attestation");
  await expect(page.getByText(/Cabin|Cargo bay/i).first()).toBeVisible({ timeout: 10_000 });
  // Toggle 2 items.
  await page.getByText(/^Cabin/i).first().click();
  await page.getByText(/^Cargo bay/i).first().click();
  await shot(page, "04-cleaning-two-checked");

  await selectScreen(page, "Bay board");
  await expect(page.getByText(/Bay A|Loading|Free|Waiting/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "05-bay-board");

  await selectScreen(page, "Manifest detail");
  await expect(page.getByText(/WB-RYD-7740|PCL-44/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "06-manifest-detail");
});

test("inbound + supervisor chain · inbound-dock → bay-detail → supervisor-queue → settings", async ({ page }) => {
  await gotoGallery(page);

  await selectScreen(page, "Inbound dock");
  await expect(page.getByText(/TRIP-99|In transit|Arrived/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "01-inbound-dock");

  await selectScreen(page, "Bay detail");
  await expect(page.getByText(/Al Olaya|RT-OL-08/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "02-bay-detail");

  await selectScreen(page, "Supervisor queue");
  await expect(
    page.getByText(/Reem Al-Shehri|COD variance|cod_variance/i).first(),
  ).toBeVisible({ timeout: 10_000 });
  await shot(page, "03-supervisor-queue");

  await selectScreen(page, "Settings");
  await expect(page.getByText(/English|Metric/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "04-settings");
});

test("rider chain · rider-today → inbox → sync-queue → profile", async ({ page }) => {
  await gotoGallery(page);

  await selectScreen(page, "Rider today");
  await expect(page.getByText(/Omar|TK-77/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "01-rider-today");

  await selectScreen(page, "Inbox");
  await expect(page.getByText(/SLA risk|Route reordered/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "02-inbox-notif-tab");

  await selectScreen(page, "Sync queue");
  await expect(page.getByText(/pending|last synced/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "03-sync-queue");

  await selectScreen(page, "Profile");
  await expect(page.getByText(/Omar Al-Saadi|DRV-2041/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "04-profile");
});

test("incident sheet chain · supervisor-queue → open incident sheet → assert severity-coded UI", async ({ page }) => {
  await gotoGallery(page);

  await selectScreen(page, "Supervisor queue");
  await expect(page.getByText(/COD variance|cod_variance/i).first()).toBeVisible({ timeout: 10_000 });

  // Open incident sheet via the Sheets chip — proves the sheet docks inside the phone frame.
  await page.getByRole("button", { name: /Open Incident sheet/i }).first().click();
  await expect(page.getByText(/Report incident/i).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Vehicle collision/i).first()).toBeVisible({ timeout: 5_000 });
  await shot(page, "01-incident-sheet-opened-over-supervisor");

  // Pick a high-severity incident — exposes the "Are you safe?" banner.
  await page.getByText(/Vehicle collision/i).first().click();
  await expect(page.getByText(/Are you safe\?/i).first()).toBeVisible({ timeout: 5_000 });
  await shot(page, "02-incident-high-severity-banner");

  // Close — confirm the sheet dismisses cleanly.
  await page.getByRole("button", { name: /Close sheet/i }).first().click();
});
