// Mobile V2 gallery browser tests. Entry is the audit gallery URL
// (`/?v2=preview&gallery=1`) — the route exposed by `mobile-v2-preview-
// gallery.tsx` to show every screen + every inline sheet without
// requiring a full driver shell + RPC stack. Every navigation is a tap
// on the visible left-rail picker (or a chip in the Sheets row). No
// `page.goto('/mobile/...')` shortcuts and no state injection.
//
// The spec is split into two passes:
//   1) screen pass — taps each gallery entry, asserts it rendered,
//      screenshots the phone frame.
//   2) sheet pass — taps each sheet chip, asserts the bottom sheet
//      opens, screenshots, dismisses via the close button.

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const GALLERY_URL = "/?v2=preview&gallery=1";
const SCREENSHOT_DIR = path.resolve(
  __dirname,
  "__screenshots__",
  "mobile-v2-gallery",
);

// Gallery uses a two-pane layout (rail + 390×844 phone frame) so the
// viewport must be wide enough for both. 1280×900 keeps headless render
// stable across CI and local.
test.use({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: false,
});

interface ScreenSpec {
  readonly id: string;
  readonly label: string;
  /** Substring expected to appear in the rendered phone frame. */
  readonly assertion: RegExp;
}

const SCREENS: ReadonlyArray<ScreenSpec> = Object.freeze([
  { id: "login", label: "Login", assertion: /Employee ID|Verify your phone/i },
  { id: "signup", label: "Signup", assertion: /Sign-up|Step 1 of 3/i },
  { id: "role-select", label: "Role select", assertion: /Pick a role|Driver/i },
  { id: "checklist", label: "Pre-shift checklist", assertion: /Fuel|Tires/i },
  { id: "kyc-docs", label: "KYC · docs", assertion: /National ID|Driving licence/i },
  { id: "kyc-vehicle", label: "KYC · vehicle", assertion: /Plate|Istimara/i },
  { id: "kyc-vehicle-photos", label: "KYC · vehicle photos", assertion: /Front|Rear|Plate visible/i },
  { id: "cleaning", label: "Cleaning attestation", assertion: /Cabin|Cargo bay/i },
  { id: "pre-shift-gate", label: "Pre-shift gate", assertion: /Pre-shift|Daily cleaning attestation/i },
  { id: "route", label: "Route", assertion: /Filters|Sort:/i },
  { id: "map", label: "Map", assertion: /RT-RUH|pending/i },
  { id: "cod-ledger", label: "COD ledger", assertion: /Collected|Expected/i },
  { id: "loader-today", label: "Loader today", assertion: /Bay B|Wave|Cut-off/i },
  { id: "loader-manifest", label: "Loader manifest", assertion: /STP-00|scanned/i },
  { id: "bay-board", label: "Bay board", assertion: /Bay A|Loading|Free|Waiting/i },
  { id: "inbound-dock", label: "Inbound dock", assertion: /TRIP-99|In transit|Arrived/i },
  { id: "bay-detail", label: "Bay detail", assertion: /Al Olaya|RT-OL-08/i },
  { id: "manifest-detail", label: "Manifest detail", assertion: /WB-RYD-7740|PCL-44/i },
  { id: "rider-today", label: "Rider today", assertion: /Omar|TK-77/i },
  { id: "supervisor", label: "Supervisor queue", assertion: /Reem Al-Shehri|cod_variance|COD variance/i },
  { id: "inbox", label: "Inbox", assertion: /SLA risk|Route reordered/i },
  { id: "sync-queue", label: "Sync queue", assertion: /pending|last synced/i },
  { id: "settings", label: "Settings", assertion: /English|Metric/i },
  { id: "profile", label: "Profile", assertion: /Omar Al-Saadi|DRV-2041/i },
]);

interface SheetSpec {
  readonly id: string;
  readonly chipLabel: string;
  readonly assertion: RegExp;
}

const SHEETS: ReadonlyArray<SheetSpec> = Object.freeze([
  { id: "break", chipLabel: "Break", assertion: /Take a break|Break in progress/i },
  { id: "incident", chipLabel: "Incident", assertion: /Report incident/i },
  { id: "switch-lang", chipLabel: "Language", assertion: /English|العربية/i },
  { id: "support", chipLabel: "Support", assertion: /Support|App crash|topic/i },
  { id: "reassign", chipLabel: "Reassign", assertion: /Reassign|driver/i },
  { id: "reschedule", chipLabel: "Reschedule", assertion: /Reschedule|window/i },
  { id: "receive", chipLabel: "Receive", assertion: /Receive|SEAL|seal/i },
  { id: "transfer", chipLabel: "Transfer", assertion: /Transfer|Bay/i },
  { id: "damage-hold", chipLabel: "Damage hold", assertion: /Damage|scuff|severity/i },
  { id: "eod-recon", chipLabel: "EOD recon", assertion: /End of route|parcels|reconcil/i },
  { id: "permissions", chipLabel: "Permissions", assertion: /Precise location|Camera/i },
  { id: "notif-prefs", chipLabel: "Notif prefs", assertion: /SLA risk|Route changes/i },
  { id: "return", chipLabel: "Return", assertion: /refused|wrong|damaged/i },
  { id: "cash-drop", chipLabel: "Cash drop", assertion: /Cash counted/i },
]);

async function gotoGallery(page: Page): Promise<void> {
  await page.goto(GALLERY_URL, { waitUntil: "domcontentloaded" });
  // The gallery rail renders the title text first — wait for it before
  // the first interaction so the React tree is hydrated.
  await expect(page.getByText(/FieldOps V2 · Gallery/i)).toBeVisible({ timeout: 30_000 });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}

for (const screen of SCREENS) {
  test(`gallery · screen · ${screen.id} renders + screenshots`, async ({ page }) => {
    await gotoGallery(page);
    // Tap the rail entry — it's a Pressable rendered as text in the rail.
    await page.getByText(new RegExp(`^${screen.label}$`)).first().click();
    // Assert the phone frame shows expected content.
    await expect(page.getByText(screen.assertion).first()).toBeVisible({
      timeout: 10_000,
    });
    await shot(page, `screen-${screen.id}`);
  });
}

for (const sheet of SHEETS) {
  test(`gallery · sheet · ${sheet.id} opens + screenshots + closes`, async ({ page }) => {
    await gotoGallery(page);
    // Open via the chip in the Sheets section.
    await page
      .getByRole("button", { name: new RegExp(`Open ${sheet.chipLabel} sheet`, "i") })
      .first()
      .click();
    // The bottom-sheet primitive renders a Close button labelled "Close sheet".
    await expect(
      page.getByRole("button", { name: /Close sheet/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
    // Sheet-specific content check.
    await expect(page.getByText(sheet.assertion).first()).toBeVisible({
      timeout: 10_000,
    });
    await shot(page, `sheet-${sheet.id}`);
    // Dismiss to confirm onClose wiring works.
    await page.getByRole("button", { name: /Close sheet/i }).first().click();
    await expect(
      page.getByRole("button", { name: /Close sheet/i }),
    ).toHaveCount(0, { timeout: 5_000 });
  });
}
