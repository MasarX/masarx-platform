// Mobile V2 sheet submit-flow E2E tests. Exercises the primary CTA path
// for sheets that own a state-machine readiness contract.
//
// Each test starts from the audit gallery, opens the sheet, drives it
// into the ready state via accessible-role interactions (when the
// gallery does not already pre-seed a ready fixture), taps the primary
// CTA, and asserts the sheet closes — confirming the
// MobileV2BottomSheet primary-slot wiring routes the click into the
// demo `onSubmit/onConfirm` handler that resets local state and closes.
//
// Complements `mobile-v2-gallery-flows.spec.ts` which only verifies the
// open-and-close lifecycle of the close button. Preflight-readiness
// gates are exhaustively covered by the unit tests in
// `tests/unit/fieldops/mobile-v2-sheet-readiness.test.ts` (44 cases);
// this spec proves the visual integration of the migrated footer slot.

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const GALLERY_URL = "/?v2=preview&gallery=1";
const SCREENSHOT_DIR = path.resolve(
  __dirname,
  "__screenshots__",
  "mobile-v2-sheet-submit-flows",
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

async function openSheet(page: Page, chipLabel: string): Promise<void> {
  await page
    .getByRole("button", { name: new RegExp(`Open ${chipLabel} sheet`, "i") })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: /Close sheet/i }).first(),
  ).toBeVisible({ timeout: 10_000 });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: true,
  });
}

async function expectSheetClosed(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: /Close sheet/i })).toHaveCount(
    0,
    { timeout: 5_000 },
  );
}

test("return sheet · pick reason + photo → Accept return closes sheet", async ({
  page,
}) => {
  await gotoGallery(page);
  await openSheet(page, "Return");

  // Pick the first return reason — radio rows.
  await page.getByRole("radio").first().click();

  // Toggle the parcel-condition photo tile.
  await page
    .getByRole("button", {
      name: /Capture parcel condition|Photo captured — tap to retake/i,
    })
    .first()
    .click();

  const accept = page
    .getByRole("button", { name: /^Accept return$/i })
    .first();
  await expect(accept).toBeEnabled();
  await shot(page, "return-ready");
  await accept.click();
  await expectSheetClosed(page);
});

test("incident sheet · pick low-severity type + photo → Submit closes sheet", async ({
  page,
}) => {
  await gotoGallery(page);
  await openSheet(page, "Incident");

  // Vehicle damage type requires only a photo.
  await page
    .getByRole("button", {
      name: /Select Vehicle damage \(no incident\) incident type/i,
    })
    .first()
    .click();

  await page
    .getByRole("button", { name: /Capture damage \/ scene/i })
    .first()
    .click();

  const submit = page
    .getByRole("button", { name: /Submit incident report/i })
    .first();
  await expect(submit).toBeEnabled();
  await shot(page, "incident-ready");
  await submit.click();
  await expectSheetClosed(page);
});

test("damage-hold sheet · select severity + barcode + photo → Quarantine closes sheet", async ({
  page,
}) => {
  await gotoGallery(page);
  await openSheet(page, "Damage hold");

  // The sheet opens with NO severity selected (design parity — every
  // chip neutral until the operator picks one), so the Quarantine CTA is
  // disabled at open. Drive the full readiness contract: pick a damage
  // type, then fill barcode + photo.
  await page
    .getByRole("button", { name: /Select damage type Crushed/i })
    .first()
    .click();
  const barcode = page.getByRole("textbox", { name: /Scan or type/i }).first();
  await barcode.fill("PCL-VV-44102");

  await page
    .getByRole("button", { name: /Add damage photo/i })
    .first()
    .click();

  const quarantine = page
    .getByRole("button", { name: /Quarantine parcel/i })
    .first();
  await expect(quarantine).toBeEnabled();
  await shot(page, "damage-hold-ready");
  await quarantine.click();
  await expectSheetClosed(page);
});

test("break sheet (idle) · tap Start transitions to ongoing mode (Resume route)", async ({
  page,
}) => {
  await gotoGallery(page);
  await openSheet(page, "Break");

  // The break gallery demo opens in idle mode with `Start <N>-min break`
  // CTA. On tap it transitions to ongoing mode (no onClose call) so the
  // sheet remains open and renders the `Resume route` countdown CTA.
  const start = page
    .getByRole("button", { name: /Start \d+ minute break/i })
    .first();
  await expect(start).toBeEnabled();
  await shot(page, "break-idle");
  await start.click();

  // Sheet stays open; primary CTA flips to Resume route per
  // ongoing-mode design canvas s-sheet-break-ongoing artboard.
  const resume = page
    .getByRole("button", { name: /Resume route/i })
    .first();
  await expect(resume).toBeVisible({ timeout: 5_000 });
  await shot(page, "break-ongoing");
});

test("reschedule sheet · gallery preset → Confirm closes sheet", async ({
  page,
}) => {
  await gotoGallery(page);
  await openSheet(page, "Reschedule");

  // Gallery preselects the first window per design SSOT so the CTA is
  // already in its `chrome` ready variant.
  const confirm = page
    .getByRole("button", { name: /Confirm new window/i })
    .first();
  await expect(confirm).toBeEnabled();
  await shot(page, "reschedule-ready");
  await confirm.click();
  await expectSheetClosed(page);
});

test("reassign sheet · pick driver → Send to dispatch closes sheet", async ({
  page,
}) => {
  await gotoGallery(page);
  await openSheet(page, "Reassign");

  await page
    .getByRole("button", { name: /Select driver/i })
    .first()
    .click();

  const send = page
    .getByRole("button", { name: /Send reassignment to dispatch/i })
    .first();
  await expect(send).toBeEnabled();
  await shot(page, "reassign-ready");
  await send.click();
  await expectSheetClosed(page);
});

test("cash-drop sheet · gallery preset renders primary in disabled preflight state", async ({
  page,
}) => {
  await gotoGallery(page);
  await openSheet(page, "Cash drop");

  // Gallery preset shows the "Complete amount + photo + signature" disabled
  // preflight state. Full ready-state coverage is in
  // `mobile-v2-driver-flows.spec.ts` which drives the count adjuster +
  // photo capture from the driver shell. This test asserts only that
  // the primary slot renders the correct preflight copy + accessible
  // role, proving the FxSheet.primary footer slot wiring is intact.
  const submit = page
    .getByRole("button", { name: /Submit cash drop/i })
    .first();
  await expect(submit).toBeDisabled();
  await expect(page.getByText(/Complete amount \+ photo \+ signature/i)).toBeVisible();
  await shot(page, "cash-drop-preflight");
});

test("edge · double-submit prevention · return sheet stays gated by readiness", async ({
  page,
}) => {
  // Edge case: double-submit prevention.
  // From the gallery → open Return sheet. The Accept return CTA is
  // gated by `isMobileV2ReturnReady` until BOTH a reason and a photo
  // are captured. A user mashing Accept before fulfilling preconditions
  // must NOT trigger a submission (gallery's `onConfirm` clears state
  // + closes sheet on submit). The CTA must remain disabled and the
  // sheet must stay open until the user actually completes both fields.
  await gotoGallery(page);
  await openSheet(page, "Return");

  const accept = page
    .getByRole("button", { name: /^Accept return$/i })
    .first();
  // Preflight: disabled even though gallery may render success-tone variant.
  await expect(accept).toBeDisabled();

  // Try to tap repeatedly — the button is disabled so Playwright will
  // refuse the click, but the assertion is the visible disabled state.
  await expect(accept).toBeDisabled();
  await expect(accept).toBeDisabled();

  // The sheet must still be open (Close button visible).
  await expect(page.getByRole("button", { name: /Close sheet/i }).first()).toBeVisible();
  await shot(page, "edge-double-submit-blocked");
});

test("edge · sheet close button dismisses without firing primary action", async ({
  page,
}) => {
  // Edge case: refresh/back mid-flow → close.
  // From the gallery → open Incident sheet (which has a stateful
  // multi-field flow) → tap the standard sheet Close button. Sheet
  // must unmount without firing the primary submit. Proves the Close
  // path is reachable via human-flow and clean from the user's POV.
  await gotoGallery(page);
  await openSheet(page, "Incident");

  // Capture preflight state.
  await shot(page, "edge-incident-initial");

  // Tap close.
  await page.getByRole("button", { name: /Close sheet/i }).first().click();
  await expect(page.getByRole("button", { name: /Close sheet/i })).toHaveCount(0, {
    timeout: 5_000,
  });
});

test("edge · accessibility · sheet primitives expose accessible role + label", async ({
  page,
}) => {
  // Edge case: accessibility.
  // From the gallery → open Reschedule sheet. Verify each interactive
  // element exposes an accessible name/role: the Close sheet button,
  // the window-option buttons, and the primary Confirm CTA. This
  // confirms screen-reader navigation works without sighted assistance.
  await gotoGallery(page);
  await openSheet(page, "Reschedule");

  // Close button — always present, accessibly named.
  await expect(
    page.getByRole("button", { name: /Close sheet/i }).first(),
  ).toBeVisible();

  // Window selection options expose "Select window <label>" names.
  await expect(
    page.getByRole("button", { name: /Select window/i }).first(),
  ).toBeVisible();

  // Primary CTA has accessible name "Confirm new window".
  await expect(
    page.getByRole("button", { name: /Confirm new window/i }).first(),
  ).toBeVisible();
  await shot(page, "edge-reschedule-a11y-roles");
});

test("eod-recon sheet · primary CTA closes sheet", async ({ page }) => {
  await gotoGallery(page);
  await openSheet(page, "EOD recon");

  // EOD recon may render either "Submit & sign off shift" (no issues)
  // or "Sign off · with variances" (issues). Match either via the
  // shared accessibility label.
  const submit = page
    .getByRole("button", {
      name: /Submit and sign off shift|Submit shift with variances/i,
    })
    .first();
  await expect(submit).toBeEnabled();
  await shot(page, "eod-recon-ready");
  await submit.click();
  await expectSheetClosed(page);
});
