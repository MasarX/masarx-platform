// One-off visual diff harness — captures the design demo
// (`http://localhost:8090/FieldOps V2.html` with showCanvas=true) and
// our implementation gallery, both at the same viewport, then writes
// per-screen PNGs into __screenshots__/visual-diff/ for side-by-side
// review. Run only when both dev servers are up.

import { test, type Page } from "@playwright/test";
import path from "node:path";

const DESIGN_URL = "http://localhost:8090/canvas.html"; // canvas-mode copy with showCanvas=true
const DESIGN_LIVE_URL = "http://localhost:8090/FieldOps%20V2.html"; // single working prototype frame
const IMPL_GALLERY_URL = "/?v2=preview&gallery=1";
const OUT_DIR = path.resolve(__dirname, "__screenshots__", "visual-diff");

test.use({
  viewport: { width: 2400, height: 1400 },
  deviceScaleFactor: 1,
});

// Force every Geist / Geist Mono weight to fully load before capture.
// `document.fonts.ready` alone is insufficient: with `font-display: swap`
// a face stays "unloaded" until a glyph triggers it, so `.ready` can
// resolve while text is still painted in the system fallback. Explicitly
// `document.fonts.load(...)` each weight, await it, then await `.ready` —
// this guarantees both the design canvas and the impl gallery screenshot
// the real Geist render, not a fallback (the dominant cross-renderer
// pixel-diff drift source when the impl silently fell back).
async function waitForFonts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (typeof document === "undefined" || !document.fonts) return;
    const families = ["Geist", "Geist Mono"];
    const weights = ["400", "500", "600", "700"];
    try {
      await Promise.all(
        families.flatMap((family) =>
          weights.map((weight) => document.fonts.load(`${weight} 16px "${family}"`)),
        ),
      );
    } catch {
      /* a missing weight must not block the capture */
    }
    if (document.fonts.ready) await document.fonts.ready;
  });
  // One rAF so the swap repaint lands before the screenshot.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

async function shot(page: Page, name: string): Promise<void> {
  await waitForFonts(page);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: true });
}

// Capture the impl phone frame by its exact element bounding box. The
// gallery tags the 380×780 frame card with testID `mobile-v2-pixel-frame`,
// so the impl PNG is a native 380×780 capture that aligns 1:1 with the
// design artboard — no full-page screenshot, no fixed-rectangle crop, and
// therefore no crop-misalignment drift inflating the pixel-diff.
async function shotFrame(page: Page, name: string): Promise<void> {
  await waitForFonts(page);
  await page
    .getByTestId("mobile-v2-pixel-frame")
    .first()
    .screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
}

test("capture design canvas — full overview", async ({ page }) => {
  await page.goto(DESIGN_URL, { waitUntil: "networkidle", timeout: 60_000 });
  // The demo uses Babel-standalone; give it time to compile + render.
  await page.waitForTimeout(4000);
  await shot(page, "design-canvas-fullpage");
});

test("capture design live-app — login starting screen", async ({ page }) => {
  await page.goto(DESIGN_LIVE_URL, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(4000);
  await shot(page, "design-live-login");
});

const IMPL_SCREENS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["login", "Login"],
  ["signup", "Signup"],
  ["role-select", "Role select"],
  ["checklist", "Pre-shift checklist"],
  ["kyc-docs", "KYC · docs"],
  ["kyc-vehicle", "KYC · vehicle"],
  ["kyc-vehicle-photos", "KYC · vehicle photos"],
  ["cleaning", "Cleaning attestation"],
  ["pre-shift-gate", "Pre-shift gate"],
  ["tasks", "Tasks"],
  ["route", "Route"],
  ["pod", "POD composer"],
  ["stop-detail", "Stop detail"],
  ["pickups", "Pickups"],
  ["pickup-detail", "Pickup detail"],
  ["trips", "Trips"],
  ["map", "Map"],
  ["cod-ledger", "COD ledger"],
  ["wallet", "Wallet"],
  ["loader-today", "Loader today"],
  ["loader-manifest", "Loader manifest"],
  ["bay-board", "Bay board"],
  ["inbound-dock", "Inbound dock"],
  ["bay-detail", "Bay detail"],
  ["manifest-detail", "Manifest detail"],
  ["rider-today", "Rider today"],
  ["supervisor", "Supervisor queue"],
  ["inbox", "Inbox"],
  ["sync-queue", "Sync queue"],
  ["more", "More"],
  ["settings", "Settings"],
  ["profile", "Profile"],
]);

for (const [id, label] of IMPL_SCREENS) {
  test(`impl screen · ${id}`, async ({ page, baseURL }) => {
    // Use the real impl base URL (8082) since baseURL is set up for it.
    await page.goto(`${baseURL}${IMPL_GALLERY_URL}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page.getByText(new RegExp(`^${label}$`)).first().click();
    await page.waitForTimeout(400);
    await shotFrame(page, `impl-${id}`);
  });
}

// Sheet captures — opens each sheet from the gallery via its "Open <name>
// sheet" button and screenshots the phone frame with the bottom-sheet
// rendered. The pixel-diff harness pairs `impl-sheet-<id>.png` with
// `design-sheet-<id>.png` (captured by capture-design-anchors.spec.ts via
// the `sh-*` artboards). Naming aligns with the gallery `SHEETS` table in
// `mobile-v2-gallery-flows.spec.ts` so adding a sheet here only requires
// matching entries in both specs.
const IMPL_SHEETS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["cash-drop", "Cash drop"],
  ["break", "Break"],
  ["incident", "Incident"],
  ["return", "Return"],
  ["reassign", "Reassign"],
  ["reschedule", "Reschedule"],
  ["receive", "Receive"],
  ["transfer", "Transfer"],
  ["damage-hold", "Damage hold"],
  ["eod-recon", "EOD recon"],
  ["support", "Support"],
  ["switch-lang", "Language"],
  ["permissions", "Permissions"],
]);

for (const [id, chipLabel] of IMPL_SHEETS) {
  test(`impl sheet · ${id}`, async ({ page, baseURL }) => {
    await page.goto(`${baseURL}${IMPL_GALLERY_URL}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page
      .getByRole("button", { name: new RegExp(`Open ${chipLabel} sheet`, "i") })
      .first()
      .click();
    // Wait for the bottom sheet primitive to render (it always exposes a
    // "Close sheet" button when open).
    await page.waitForTimeout(600);
    await shotFrame(page, `impl-sheet-${id}`);
  });
}
