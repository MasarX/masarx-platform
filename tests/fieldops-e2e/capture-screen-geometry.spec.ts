// Element-geometry capture harness — the same-renderer diff upgrade.
//
// The pixel-diff (`fieldops-v2-pixel-diff.js`) reports an opaque RMS%; it
// cannot tell a genuine layout defect from cross-renderer anti-aliasing.
// This spec instead extracts, for every design artboard and every impl
// screen, the frame-relative bounding box of each rendered text run, and
// writes them as JSON. `fieldops-v2-element-diff.js` then pairs design↔impl
// runs by text and reports exact px deltas — actionable drift, not RMS.
//
// Both the design canvas (Babel-HTML) and the impl gallery (React Native
// Web) render in the same Chromium under Playwright with the same Geist
// fonts, so a text run's box is directly comparable across the two.
//
// Drives the same Playwright config as `capture-design-vs-impl.spec.ts`
// (design server 8090, impl server on baseURL).

import { test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const DESIGN_URL = "http://localhost:8090/canvas.html";
const IMPL_GALLERY_URL = "/?v2=preview&gallery=1";
const OUT_DIR = path.resolve(__dirname, "__screenshots__", "visual-diff", "geometry");

test.use({
  viewport: { width: 2400, height: 1400 },
  deviceScaleFactor: 1,
});

// design anchor id → shared pair name (mirrors capture-design-anchors.spec.ts)
const DESIGN_ANCHORS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["tk-driver", "tasks"], ["s-login", "login"], ["s-signup", "signup"],
  ["s-role", "role-select"], ["s-check", "checklist"], ["s-kyc-id", "kyc-docs"],
  ["s-kyc-veh", "kyc-vehicle"], ["s-kyc-photos", "kyc-vehicle-photos"],
  ["s-cleaning", "cleaning"], ["s-preshift", "pre-shift-gate"], ["s-route", "route"],
  ["s-map", "map"], ["p-scan", "pod"], ["l-today", "loader-today"],
  ["l-manifest", "loader-manifest"], ["l-bay", "bay-board"], ["n-inbound", "inbound-dock"],
  ["n-bay", "bay-detail"], ["n-manifest", "manifest-detail"], ["r-today", "rider-today"],
  ["s-stop", "stop-detail"], ["n-pickups", "pickups"], ["n-pickup-detail", "pickup-detail"],
  ["n-trips", "trips"], ["n-wallet", "wallet"], ["s-cod", "cod-ledger"],
  ["s-inbox", "inbox"], ["s-prof", "profile"], ["s-set", "settings"],
  ["s-sync", "sync-queue"], ["sv-q", "supervisor"], ["sh-cash", "sheet-cash-drop"],
  ["sh-break", "sheet-break"], ["sh-inc", "sheet-incident"], ["sh-ret", "sheet-return"],
  ["sh-rea", "sheet-reassign"], ["sh-res", "sheet-reschedule"], ["sh-recv", "sheet-receive"],
  ["sh-tx", "sheet-transfer"], ["sh-dmg", "sheet-damage-hold"], ["sh-eod", "sheet-eod-recon"],
  ["sh-sup", "sheet-support"], ["sh-lang", "sheet-switch-lang"], ["sh-perm", "sheet-permissions"],
]);

// impl gallery screen entries (name → visible label) — mirrors capture-design-vs-impl.spec.ts
const IMPL_SCREENS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["login", "Login"], ["signup", "Signup"], ["role-select", "Role select"],
  ["checklist", "Pre-shift checklist"], ["kyc-docs", "KYC · docs"],
  ["kyc-vehicle", "KYC · vehicle"], ["kyc-vehicle-photos", "KYC · vehicle photos"],
  ["cleaning", "Cleaning attestation"], ["pre-shift-gate", "Pre-shift gate"],
  ["tasks", "Tasks"], ["route", "Route"], ["pod", "POD composer"],
  ["stop-detail", "Stop detail"], ["pickups", "Pickups"], ["pickup-detail", "Pickup detail"],
  ["trips", "Trips"], ["map", "Map"], ["cod-ledger", "COD ledger"], ["wallet", "Wallet"],
  ["loader-today", "Loader today"], ["loader-manifest", "Loader manifest"],
  ["bay-board", "Bay board"], ["inbound-dock", "Inbound dock"], ["bay-detail", "Bay detail"],
  ["manifest-detail", "Manifest detail"], ["rider-today", "Rider today"],
  ["supervisor", "Supervisor queue"], ["inbox", "Inbox"], ["sync-queue", "Sync queue"],
  ["settings", "Settings"], ["profile", "Profile"],
]);

// impl gallery sheet entries (name → "Open <chip> sheet" button label)
const IMPL_SHEETS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["sheet-cash-drop", "Cash drop"], ["sheet-break", "Break"], ["sheet-incident", "Incident"],
  ["sheet-return", "Return"], ["sheet-reassign", "Reassign"], ["sheet-reschedule", "Reschedule"],
  ["sheet-receive", "Receive"], ["sheet-transfer", "Transfer"], ["sheet-damage-hold", "Damage hold"],
  ["sheet-eod-recon", "EOD recon"], ["sheet-support", "Support"], ["sheet-switch-lang", "Language"],
  ["sheet-permissions", "Permissions"],
]);

interface TextRun {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fs: number;
  fw: number;
}

// Serialisable in-page selector → text-run list. `slotSelector` (design
// only) scopes the search to one artboard; null resolves the impl phone
// frame by testID.
//
// Each run is measured by the bounding box of the element's *own* direct
// text nodes (via Range), NOT the element box. The design (HTML) puts the
// text directly on a `<button>`/chip container while the impl (RN Web)
// nests it in an inner `<div>`; measuring the element box would compare a
// 346px button against a 71px text node. The text-glyph Range box is the
// same physical thing on both renderers, so its delta is genuine drift.
const EXTRACT = (slotSelector: string | null): TextRun[] => {
  let frame: Element | null = null;
  if (slotSelector) {
    const slot = document.querySelector(slotSelector);
    if (slot) {
      for (const el of Array.from(slot.querySelectorAll("*"))) {
        if (Math.abs(el.getBoundingClientRect().width - 380) < 3) {
          frame = el;
          break;
        }
      }
    }
  } else {
    frame = document.querySelector('[data-testid="mobile-v2-pixel-frame"]');
  }
  if (!frame) return [];
  const fr = frame.getBoundingClientRect();
  const runs: TextRun[] = [];
  for (const el of Array.from(frame.querySelectorAll("*"))) {
    const textNodes = Array.from(el.childNodes).filter(
      (n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0,
    );
    if (textNodes.length === 0) continue;
    // union of the direct text nodes' Range rects = the glyph box
    let box: { l: number; t: number; r: number; b: number } | null = null;
    for (const n of textNodes) {
      const range = document.createRange();
      range.setStart(n, 0);
      range.setEnd(n, (n.textContent ?? "").length);
      const rr = range.getBoundingClientRect();
      if (rr.width === 0 || rr.height === 0) continue;
      box = box
        ? {
            l: Math.min(box.l, rr.left),
            t: Math.min(box.t, rr.top),
            r: Math.max(box.r, rr.right),
            b: Math.max(box.b, rr.bottom),
          }
        : { l: rr.left, t: rr.top, r: rr.right, b: rr.bottom };
    }
    if (!box) continue;
    const x = box.l - fr.x;
    const y = box.t - fr.y;
    // Clip to the visible 380×780 phone frame. A design artboard lays the
    // full screen out tall (e.g. a 12-stop route list ~1300px); a run
    // whose box is below the fold (or off to the side) is NOT visible in
    // the captured PNG and must not be diffed — including it would pair
    // off-screen design runs against nothing on the impl viewport.
    if (y >= fr.height - 1 || box.b - fr.y <= 1 || x >= fr.width - 1 || box.r - fr.x <= 1) {
      continue;
    }
    const cs = getComputedStyle(el);
    const round1 = (v: number) => Math.round(v * 10) / 10;
    runs.push({
      t: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
      x: round1(x),
      y: round1(y),
      w: round1(box.r - box.l),
      h: round1(box.b - box.t),
      fs: round1(parseFloat(cs.fontSize)),
      fw: Number.parseInt(cs.fontWeight, 10) || 400,
    });
  }
  return runs;
};

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
}

test("design — capture text-run geometry for every artboard", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(DESIGN_URL, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(5000);
  await waitForFonts(page);

  const out: Record<string, TextRun[]> = {};
  for (const [anchorId, name] of DESIGN_ANCHORS) {
    const locator = page.locator(`[data-dc-slot="${anchorId}"]`).first();
    if ((await locator.count()) === 0) continue;
    await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
    await page.waitForTimeout(150);
    out[name] = await page.evaluate(EXTRACT, `[data-dc-slot="${anchorId}"]`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "design.json"), JSON.stringify(out, null, 2));
});

test("impl — capture text-run geometry for every screen + sheet", async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const out: Record<string, TextRun[]> = {};

  for (const [name, label] of IMPL_SCREENS) {
    await page.goto(`${baseURL}${IMPL_GALLERY_URL}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page.getByText(new RegExp(`^${label}$`)).first().click();
    await page.waitForTimeout(400);
    await waitForFonts(page);
    out[name] = await page.evaluate(EXTRACT, null);
  }
  for (const [name, chip] of IMPL_SHEETS) {
    await page.goto(`${baseURL}${IMPL_GALLERY_URL}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page
      .getByRole("button", { name: new RegExp(`Open ${chip} sheet`, "i") })
      .first()
      .click();
    await page.waitForTimeout(600);
    await waitForFonts(page);
    out[name] = await page.evaluate(EXTRACT, null);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "impl.json"), JSON.stringify(out, null, 2));
});
