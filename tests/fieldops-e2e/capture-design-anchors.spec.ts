// Per-anchor design capture harness. The canvas.html demo lays every
// design screen as an `[id="<anchor>"]` artboard (380×780). This spec
// scrolls to each anchor and screenshots only the artboard's bounding
// box so we can pixel-diff one design screen vs one impl screen at
// matching dimensions.
//
// Drives the same Playwright config as `capture-design-vs-impl.spec.ts`
// — assumes both servers (8090 design / 8082 impl) are already up.

import { test, type Page } from "@playwright/test";
import path from "node:path";

const DESIGN_URL = "http://localhost:8090/canvas.html";
const OUT_DIR = path.resolve(__dirname, "__screenshots__", "visual-diff");

test.use({
  viewport: { width: 2400, height: 1400 },
  deviceScaleFactor: 1,
});

// Anchor IDs in the design canvas → output names. Each value pairs the
// design `ab(...)` artboard id with the impl gallery screen id (or a
// new shorthand) so the pixel-diff script can match pairs.
const DESIGN_ANCHORS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["tk-driver", "tasks"],
  ["s-login", "login"],
  ["s-signup", "signup"],
  ["s-role", "role-select"],
  ["s-check", "checklist"],
  ["s-kyc-id", "kyc-docs"],
  ["s-kyc-veh", "kyc-vehicle"],
  ["s-kyc-photos", "kyc-vehicle-photos"],
  ["s-cleaning", "cleaning"],
  ["s-preshift", "pre-shift-gate"],
  ["s-route", "route"],
  ["s-map", "map"],
  ["p-scan", "pod"],
  ["l-today", "loader-today"],
  ["l-manifest", "loader-manifest"],
  ["l-bay", "bay-board"],
  ["n-inbound", "inbound-dock"],
  ["n-bay", "bay-detail"],
  ["n-manifest", "manifest-detail"],
  ["r-today", "rider-today"],
  // Audit gallery expansion — previously unpaired impl screens that
  // have a corresponding design artboard in canvas.html.
  ["s-stop", "stop-detail"],
  ["n-pickups", "pickups"],
  ["n-pickup-detail", "pickup-detail"],
  ["n-trips", "trips"],
  ["n-wallet", "wallet"],
  ["s-cod", "cod-ledger"],
  ["s-inbox", "inbox"],
  ["s-prof", "profile"],
  ["s-set", "settings"],
  ["s-sync", "sync-queue"],
  ["sv-q", "supervisor"],
  // Sheet artboards — design canvas renders each sheet standalone in a
  // 380×780 phone frame; impl renders the sheet as a bottom-sheet over a
  // base screen. Naming uses `sheet-<id>` to match the impl gallery
  // `SHEETS` convention so `derivePairs` auto-couples them. sh-pod and
  // sh-fail are intentionally omitted — they have no impl gallery sheet
  // counterpart (POD/Fail are inline driver chain, not modal sheets).
  ["sh-cash", "sheet-cash-drop"],
  ["sh-break", "sheet-break"],
  ["sh-inc", "sheet-incident"],
  ["sh-ret", "sheet-return"],
  ["sh-rea", "sheet-reassign"],
  ["sh-res", "sheet-reschedule"],
  ["sh-recv", "sheet-receive"],
  ["sh-tx", "sheet-transfer"],
  ["sh-dmg", "sheet-damage-hold"],
  ["sh-eod", "sheet-eod-recon"],
  ["sh-sup", "sheet-support"],
  ["sh-lang", "sheet-switch-lang"],
  ["sh-perm", "sheet-permissions"],
]);

test("design — scroll + capture each anchor", async ({ page }) => {
  await page.goto(DESIGN_URL, { waitUntil: "networkidle", timeout: 60_000 });
  // Babel-standalone needs time to compile + render the React canvas.
  await page.waitForTimeout(5000);
  // Block screenshot until every Geist + Geist Mono weight is fully loaded
  // (canvas.html pulls them from Google Fonts via <link>). `.ready` alone
  // can resolve mid-`font-display:swap`, so each weight is explicitly
  // `document.fonts.load(...)`-ed first — this matches the impl capture's
  // font-wait so both sides screenshot the identical Geist render.
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

  for (const [anchorId, outName] of DESIGN_ANCHORS) {
    const locator = page.locator(`[data-dc-slot="${anchorId}"]`).first();
    const count = await locator.count();
    if (count === 0) {
      // eslint-disable-next-line no-console
      console.warn(`design anchor "${anchorId}" not found — skipping`);
      continue;
    }
    await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
    await page.waitForTimeout(400);
    // Find the inner phone artboard (380×780 frame). The `ab()` helper
    // typically wraps content in a centered phone card; look for the
    // first descendant with width ≈ 380.
    const box = await locator.boundingBox();
    if (!box) {
      // eslint-disable-next-line no-console
      console.warn(`design anchor "${anchorId}" had no bbox — skipping`);
      continue;
    }
    await page.screenshot({
      path: path.join(OUT_DIR, `design-${outName}.png`),
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: Math.min(box.width, 460),
        height: Math.min(box.height, 900),
      },
    });
  }
});
