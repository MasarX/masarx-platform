import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  LANDING_TRACKING_ENDPOINT_MOCK,
  mockTrackingEndpoint,
  mockTurnstile,
  patchRuntimeConfig,
  routePayload,
} from "./helpers";

// Runtime evidence for the WCAG 2.2 AA criteria axe cannot check on landing and public tracking (#301 slice 9).
// Each test measures its criterion, logs the evidence as JSON and must match its record in
// docs/product/ux/wcag22-conformance.json: a recorded fail stays tied to its issue, and a fix or a
// new failure on a passing record both break the test until the record changes.
const RECORDS = JSON.parse(readFileSync(join(__dirname, "../../docs/product/ux/wcag22-conformance.json"), "utf8"));
type ScreenId = "landing" | "public-tracking";
type Stage = "page" | "lookup" | "results";
type Target = { id: string; path: string };
const PAGES: Record<ScreenId, Target[]> = {
  landing: [{ id: "landing-en", path: "/" }, { id: "landing-ar", path: "/ar/" }],
  "public-tracking": [{ id: "track-en", path: "/track/" }, { id: "track-ar", path: "/ar/track/" }],
};
const STAGES: Record<ScreenId, Stage[]> = { landing: ["page"], "public-tracking": ["lookup", "results"] };
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
// Cloudflare's public always-pass test site key, so the request forms render their Turnstile host.
const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
const MISSING_REFERENCE = "TRK-2026-0404";
const TRACKING = {
  ok: true,
  tracking: {
    shipment: {
      tracking_number: "TRK-2026-0001", client_reference_number: "ORD-10088", carrier_reference_number: "CR-77421",
      status: "in_transit", service_type: "delivery", created_at: "2026-03-06T08:00:00.000Z",
      promised_delivery_date: "2026-03-07", promised_window_start_at: "2026-03-07T08:00:00.000Z",
      promised_window_end_at: "2026-03-07T17:00:00.000Z",
    },
    recipient: { name: "J******", phone: "******123", email: "j***@e******.com" },
    address: { city: "Riyadh", district: "Al Olaya", short_national_address: "******1234" },
    timeline: [{
      action_type: "status_change", action_category: "operational", status: "in_transit",
      timestamp: "2026-03-06T09:15:00.000Z", summary: "in_transit",
    }],
    actions: {
      reschedule: { enabled: true, available_dates: ["2026-03-08", "2026-03-09"] },
      location_change: { enabled: true, requires_map_pin: true, requires_short_national_address: true },
    },
  },
};

function expectRecorded(screenId: ScreenId, criterion: string, failures: string[], evidence: unknown) {
  const record = RECORDS.screens[screenId].records[criterion];
  const unique = [...new Set(failures)];
  console.log(JSON.stringify({ conformance: `${screenId}/${criterion}`, record: record.status, failures: unique, evidence }));
  expect({ status: unique.length ? "fail" : "pass", failures: unique }).toEqual({
    status: record.status,
    failures: record.status === "fail" ? unique : [],
  });
}

async function mockTracking(page: Page) {
  await patchRuntimeConfig(page, { trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK, turnstileSiteKey: TURNSTILE_TEST_SITE_KEY });
  await mockTurnstile(page);
  await mockTrackingEndpoint(page, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() || {};
    if (pathname.endsWith("/lookup") && body.reference !== MISSING_REFERENCE) {
      await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
    } else if (pathname.endsWith("/verify")) {
      await routePayload({ ...TRACKING, session_token: "sess-conformance" })(route);
    } else if (pathname.endsWith("/session")) {
      await routePayload(TRACKING)(route);
    } else {
      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    }
  });
}

async function open(page: Page, target: Target, stage: Stage, query = "?motion=off") {
  await page.goto(`${target.path}${query}`);
  if (stage === "results") {
    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await expect(page.locator('[data-track-stage="verify"]')).toBeVisible();
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();
    await expect(page.locator('[data-track-stage="results"]')).toBeVisible();
  }
  await installProbe(page);
}

const at = (target: Target, stage: Stage, extra = "") => `${target.id}${stage === "page" ? "" : `/${stage}`}${extra}`;

type Probe = {
  describe: (el: Element | null) => string;
  order: (el: Element) => number;
  snapshot: (el: Element) => string;
  baseline: WeakMap<Element, string>;
};

// Page helpers: a short unique element path, its DOM order and the unfocused style baseline.
async function installProbe(page: Page) {
  await page.evaluate(() => {
    const all = [...document.querySelectorAll("*")];
    const index = new WeakMap(all.map((el, i) => [el, i] as [Element, number]));
    const part = (node: Element) => {
      if (node.id) return `#${node.id}`;
      const data = [...node.attributes].find((a) => a.name.startsWith("data-") && !a.name.startsWith("data-i18n"));
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
      const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(node) + 1})` : "";
      return `${node.tagName.toLowerCase()}${data ? `[${data.name}]` : ""}${nth}`;
    };
    const describe = (el: Element | null) => {
      if (!el || el === document.body || el === document.documentElement) return "body";
      const parts: string[] = [];
      for (let node: Element | null = el; node && node !== document.body && parts.length < 5; node = node.parentElement) {
        parts.unshift(part(node));
        if (node.id) break;
      }
      return parts.join(" > ");
    };
    const keys = ["outlineStyle", "outlineWidth", "outlineColor", "boxShadow", "borderColor", "backgroundColor", "color", "textDecorationLine"] as const;
    const snapshot = (el: Element) => { const s = getComputedStyle(el); return keys.map((k) => s[k]).join("|"); };
    const baseline = new WeakMap<Element, string>();
    all.forEach((el) => baseline.set(el, snapshot(el)));
    (window as unknown as { __cf: Probe }).__cf = { describe, order: (el) => index.get(el) ?? -1, snapshot, baseline };
  });
}

type Stop = { path: string; order: number; tabIndex: number; indicator: boolean; hidden: boolean };

// Presses Tab from the top until focus wraps to the first stop or leaves the document.
async function tabWalk(page: Page, limit = 300): Promise<Stop[]> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const stops: Stop[] = [];
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const cf = (window as unknown as { __cf: Probe }).__cf;
      const s = getComputedStyle(el);
      // 2.4.7: an outline, a shadow or any change from the unfocused style.
      const indicator = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none" ||
        cf.baseline.get(el) !== cf.snapshot(el);
      // 2.4.11: the focused control must not be entirely hidden by author content.
      const r = el.getBoundingClientRect();
      const label = (el as HTMLInputElement).labels?.[0] ?? el.closest("label");
      const visible = r.width > 0 && r.height > 0 && [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]
        .map(([fx, fy]) => [r.left + r.width * fx, r.top + r.height * fy])
        .filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight)
        .some(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return !!hit && (hit === el || el.contains(hit) || hit.contains(el) || (!!label && label.contains(hit)));
        });
      return { path: cf.describe(el), order: cf.order(el), tabIndex: (el as HTMLElement).tabIndex, indicator, hidden: !visible };
    });
    if (!stop || (stops.length > 0 && stop.order === stops[0].order)) break;
    stops.push(stop);
  }
  return stops;
}

// Visible, enabled controls that keyboard users must reach (one per radio group).
async function expectedControls(page: Page) {
  return page.evaluate(() => {
    const cf = (window as unknown as { __cf: Probe }).__cf;
    const radios = new Set<string>();
    return [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary, [tabindex]")]
      .filter((el) => {
        if (el.tabIndex < 0 || (el as HTMLButtonElement).disabled || (el as HTMLInputElement).type === "hidden") return false;
        if (el.closest("[inert], [aria-hidden='true']") || getComputedStyle(el).visibility !== "visible") return false;
        const r = el.getBoundingClientRect();
        if (el.getClientRects().length === 0 || r.width < 2 || r.height < 2) return false;
        if ((el as HTMLInputElement).type === "radio") {
          if (radios.has((el as HTMLInputElement).name)) return false;
          radios.add((el as HTMLInputElement).name);
        }
        return true;
      })
      .map((el) => ({ path: cf.describe(el), order: cf.order(el) }));
  });
}

function keyboardFailures(where: string, stops: Stop[], expected: Array<{ path: string; order: number }>, skipOrder: number) {
  const failures: string[] = [];
  if (!stops.length) return [`${where}: Tab reaches nothing`];
  if (skipOrder >= 0 && stops[0].order !== skipOrder) failures.push(`${where}: the skip link is not the first Tab stop`);
  stops.filter((s) => s.tabIndex > 0).forEach((s) => failures.push(`${where}: positive tabindex on ${s.path}`));
  stops.filter((s) => !s.indicator).forEach((s) => failures.push(`${where}: no visible focus indicator on ${s.path}`));
  const reached = new Set(stops.map((s) => s.order));
  expected.filter((c) => !reached.has(c.order)).forEach((c) => failures.push(`${where}: Tab never reaches ${c.path}`));
  // 2.4.3: Tab follows DOM order, which is the reading order on these pages.
  const back = stops.findIndex((s, i) => i > 0 && s.order < stops[i - 1].order);
  if (back > 0) failures.push(`${where}: Tab goes back to ${stops[back].path} after ${stops[back - 1].path}`);
  return failures;
}

// The map dialog takes focus, keeps Tab inside, closes on Escape and returns focus to its trigger.
async function mapDialogFailures(page: Page, where: string) {
  const failures: string[] = [];
  const overlay = page.locator("[data-track-map-overlay]");
  const inDialog = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  await page.locator("[data-track-map-expand]").focus();
  await page.keyboard.press("Enter");
  await expect(overlay).toBeVisible();
  await expect.poll(inDialog, { message: "the open map dialog takes focus" }).toBe(true)
    .catch(() => failures.push(`${where}: opening the map dialog does not move focus into it`));
  const controls = await overlay.locator('[role="dialog"]').evaluate((dialog) =>
    [...dialog.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")]
      .filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0).length);
  for (let i = 0; i <= controls; i += 1) {
    await page.keyboard.press("Tab");
    if (!(await inDialog())) {
      const path = await page.evaluate(() => (window as unknown as { __cf: Probe }).__cf.describe(document.activeElement));
      failures.push(`${where}: Tab leaves the open map dialog to ${path}`);
      break;
    }
  }
  const close = overlay.locator("[data-track-map-close]");
  await close.focus();
  await page.keyboard.press("Escape");
  if (await overlay.isVisible()) {
    failures.push(`${where}: Escape on a map dialog button does not close the dialog`);
    await close.click();
  }
  await expect(overlay).toBeHidden();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.hasAttribute("data-track-map-expand")),
    { message: "focus returns to the map trigger" }).toBe(true)
    .catch(() => failures.push(`${where}: closing the map dialog does not return focus to its trigger`));
  return failures;
}

// Text that the viewport edge cuts part-way; html and body clip horizontal overflow, so scrollWidth cannot show it.
async function cutText(page: Page) {
  return page.evaluate(() => {
    const cf = (window as unknown as { __cf: Probe }).__cf;
    const cut = new Set<string>();
    document.body.querySelectorAll<HTMLElement>("*").forEach((el) => {
      if (![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())) return;
      if (el.closest("[aria-hidden='true'], [hidden]") || getComputedStyle(el).visibility !== "visible") return;
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return;
      if (!((r.left < -1 && r.right > 1) || (r.right > innerWidth + 1 && r.left < innerWidth - 1))) return;
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        if ((ox === "auto" || ox === "scroll") && a.scrollWidth > a.clientWidth) return; // the region scrolls on its own
      }
      cut.add(cf.describe(el));
    });
    return [...cut];
  });
}

// Text that becomes clipped once the WCAG 1.4.12 spacing is applied.
async function newlyClippedBySpacing(page: Page) {
  return page.evaluate(() => {
    const cf = (window as unknown as { __cf: Probe }).__cf;
    const texts = [...document.body.querySelectorAll<HTMLElement>("*")].filter((el) =>
      [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) &&
      !el.closest("[aria-hidden='true'], [hidden]"));
    const clipped = () => new Set(texts.filter((el) => {
      if (getComputedStyle(el).visibility !== "visible") return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return false;
      for (let a: HTMLElement | null = el; a && a !== document.body; a = a.parentElement) {
        const s = getComputedStyle(a);
        const clipX = s.overflowX === "hidden" || s.overflowX === "clip";
        const clipY = s.overflowY === "hidden" || s.overflowY === "clip";
        if (a === el) {
          if ((clipX && a.scrollWidth > a.clientWidth + 1) || (clipY && a.scrollHeight > a.clientHeight + 1)) return true;
          continue;
        }
        const box = a.getBoundingClientRect();
        if ((clipX && (r.left < box.left - 1 || r.right > box.right + 1)) || (clipY && (r.top < box.top - 1 || r.bottom > box.bottom + 1))) return true;
      }
      return false;
    }));
    const before = clipped();
    const style = document.createElement("style");
    style.textContent = "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }";
    document.head.appendChild(style);
    const after = clipped();
    style.remove();
    return [...new Set([...after].filter((el) => !before.has(el)).map((el) => cf.describe(el)))];
  });
}

// Help mechanisms in DOM order, by kind (3.2.6).
async function helpOrder(page: Page) {
  return page.evaluate(() => {
    const kinds: string[] = [];
    document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
      const url = new URL(a.href, location.href);
      const kind = url.hash === "#faq" ? "faq" : url.hash === "#contact" || /^(mailto|tel):$/.test(url.protocol) ? "contact" : "";
      if (kind && !kinds.includes(kind)) kinds.push(kind);
    });
    return kinds;
  });
}

// Running animations whose total time is over 5 seconds.
async function longMotion(page: Page) {
  return page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    return document.getAnimations()
      .filter((a) => {
        const t = a.effect?.getComputedTiming();
        if (!t || a.playState !== "running") return false;
        return t.iterations === Infinity || Number(t.duration) * Number(t.iterations) > 5000;
      })
      .map((a) => {
        const effect = a.effect as KeyframeEffect | null;
        const el = effect?.target;
        const name = (a as CSSAnimation).animationName || "animation";
        const cls = el?.getAttribute("class")?.split(/\s+/)[0];
        return `${name} on ${el ? `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${effect?.pseudoElement || ""}` : "document"}`;
      });
  });
}

for (const screenId of Object.keys(PAGES) as ScreenId[]) {
  test.describe(screenId, () => {
    test.beforeEach(async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(DESKTOP);
      await page.emulateMedia({ reducedMotion: "reduce" });
      if (screenId === "public-tracking") await mockTracking(page);
    });

    test(`conformance ${screenId}: keyboard-focus-order (2.1.1, 2.4.3, 2.4.7)`, async ({ page }) => {
      const failures: string[] = [];
      const evidence: Record<string, unknown> = {};
      for (const target of PAGES[screenId]) {
        for (const stage of STAGES[screenId]) {
          await open(page, target, stage);
          const where = at(target, stage);
          const expected = await expectedControls(page);
          const skipOrder = await page.evaluate(() => {
            const skip = document.querySelector(".skip-link");
            return skip ? (window as unknown as { __cf: Probe }).__cf.order(skip) : -1;
          });
          const stops = await tabWalk(page);
          evidence[where] = { stops: stops.length, expected: expected.length, first: stops[0]?.path };
          failures.push(...keyboardFailures(where, stops, expected, skipOrder));
          if (stage === "results") failures.push(...(await mapDialogFailures(page, where)));
        }
      }
      expectRecorded(screenId, "keyboard-focus-order", failures, evidence);
    });

    test(`conformance ${screenId}: focus-not-obscured (2.4.11)`, async ({ page }) => {
      const failures: string[] = [];
      const evidence: Record<string, number> = {};
      for (const size of [DESKTOP, PHONE]) {
        await page.setViewportSize(size);
        for (const target of PAGES[screenId]) {
          for (const stage of STAGES[screenId]) {
            await open(page, target, stage);
            const where = at(target, stage, `@${size.width}`);
            const stops = await tabWalk(page);
            evidence[where] = stops.length;
            stops.filter((s) => s.hidden).forEach((s) => failures.push(`${where}: focused ${s.path} is entirely hidden`));
          }
        }
      }
      expectRecorded(screenId, "focus-not-obscured", failures, evidence);
    });

    test(`conformance ${screenId}: reflow-320 (1.4.10)`, async ({ page }) => {
      const failures: string[] = [];
      await page.setViewportSize({ width: 320, height: 800 });
      for (const target of PAGES[screenId]) {
        for (const stage of STAGES[screenId]) {
          await open(page, target, stage);
          (await cutText(page)).forEach((p) => failures.push(`${at(target, stage)}: text cut by the 320px viewport at ${p}`));
        }
      }
      expectRecorded(screenId, "reflow-320", failures, { width: 320 });
    });

    test(`conformance ${screenId}: text-spacing (1.4.12)`, async ({ page }) => {
      const failures: string[] = [];
      for (const size of [DESKTOP, PHONE]) {
        await page.setViewportSize(size);
        for (const target of PAGES[screenId]) {
          for (const stage of STAGES[screenId]) {
            await open(page, target, stage);
            (await newlyClippedBySpacing(page)).forEach((p) =>
              failures.push(`${at(target, stage, `@${size.width}`)}: text clipped with 1.4.12 spacing at ${p}`));
          }
        }
      }
      expectRecorded(screenId, "text-spacing", failures, { widths: [DESKTOP.width, PHONE.width] });
    });

    test(`conformance ${screenId}: accessible-authentication (3.3.8)`, async ({ page }) => {
      const failures: string[] = [];
      // The inputs that prove who may see a record: none may block paste or a password manager.
      const fields = screenId === "landing" ? ['input[name="status_token"]'] : ['input[name="reference"]', 'input[name="phone_last3"]'];
      for (const target of PAGES[screenId]) {
        await open(page, target, STAGES[screenId][0]);
        for (const selector of fields) {
          const result = await page.locator(selector).evaluate((el: HTMLInputElement) => {
            const paste = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
            el.dispatchEvent(paste);
            return { blocked: paste.defaultPrevented, readOnly: el.readOnly };
          });
          if (result.blocked) failures.push(`${target.id}: paste is blocked in ${selector}`);
          if (result.readOnly) failures.push(`${target.id}: ${selector} is read-only`);
        }
      }
      expectRecorded(screenId, "accessible-authentication", failures, { fields });
    });

    test(`conformance ${screenId}: consistent-help (3.2.6)`, async ({ page }) => {
      const failures: string[] = [];
      const orders: Record<string, string[]> = {};
      for (const lang of [0, 1]) {
        const pair = [PAGES.landing[lang], PAGES["public-tracking"][lang]];
        for (const target of pair) {
          await page.goto(`${target.path}?motion=off`);
          orders[target.id] = await helpOrder(page);
        }
        const [a, b] = pair.map((t) => orders[t.id]);
        const sharedA = a.filter((k) => b.includes(k));
        const sharedB = b.filter((k) => a.includes(k));
        if (!sharedA.length) failures.push(`${pair[0].id} and ${pair[1].id} share no help mechanism`);
        if (sharedA.join() !== sharedB.join()) failures.push(`${pair[0].id} and ${pair[1].id} order help differently`);
      }
      expectRecorded(screenId, "consistent-help", failures, orders);
    });

    test(`conformance ${screenId}: redundant-entry (3.3.7)`, async ({ page }) => {
      const failures: string[] = [];
      for (const target of PAGES[screenId]) {
        if (screenId === "landing") {
          // The documents step follows the status lookup and must not ask for the token again.
          await open(page, target, "page");
          const asked = await page.locator("[data-driver-documents-form]").evaluate((form) =>
            [...form.querySelectorAll<HTMLInputElement>("input, textarea, select")]
              .filter((el) => el.name === "status_token" && el.type !== "hidden").length);
          if (asked) failures.push(`${target.id}: the documents step asks for the status token again`);
          continue;
        }
        await open(page, target, "lookup");
        await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
        await page.locator('[data-track-lookup-form] button[type="submit"]').click();
        await expect(page.locator('[data-track-stage="verify"]')).toBeVisible();
        await page.locator("[data-track-back]").click();
        const kept = await page.locator('[data-track-lookup-form] input[name="reference"]').inputValue();
        if (kept !== "TRK-2026-0001") failures.push(`${target.id}: Back from verify clears the entered reference`);
        await open(page, target, "results");
        const repeated = await page.locator("[data-track-reschedule-form], [data-track-location-form]").evaluateAll((forms) =>
          forms.flatMap((form) => [...form.querySelectorAll<HTMLInputElement>("input, textarea, select")]
            .filter((el) => ["reference", "phone_last3", "tracking_number"].includes(el.name) && el.type !== "hidden")
            .map((el) => el.name)));
        repeated.forEach((name) => failures.push(`${target.id}: a request form asks again for ${name}`));
      }
      expectRecorded(screenId, "redundant-entry", failures, {});
    });

    test(`conformance ${screenId}: status-messages (4.1.3)`, async ({ page }) => {
      const failures: string[] = [];
      for (const target of PAGES[screenId]) {
        for (const stage of STAGES[screenId]) {
          await open(page, target, stage);
          const silent = await page.evaluate(() => [...document.querySelectorAll("form")]
            .filter((form) => !form.querySelector('[aria-live="polite"], [aria-live="assertive"], [role="status"], [role="alert"], [role="log"]'))
            .map((form) => [...form.attributes].find((a) => a.name.startsWith("data-"))?.name || "form"));
          silent.forEach((name) => failures.push(`${at(target, stage)}: ${name} has no live status region`));
        }
        if (screenId === "public-tracking") {
          await open(page, target, "lookup");
          await page.locator('[data-track-lookup-form] input[name="reference"]').fill(MISSING_REFERENCE);
          await page.locator('[data-track-lookup-form] button[type="submit"]').click();
          await expect.poll(() => page.locator("[data-track-lookup-status]").innerText(), { message: "failed lookup status" })
            .not.toBe("")
            .catch(() => failures.push(`${target.id}: a failed lookup announces nothing in its live region`));
        }
      }
      expectRecorded(screenId, "status-messages", failures, {});
    });

    test(`conformance ${screenId}: reduced-motion (2.2.2, DESIGN.md section 9)`, async ({ page }) => {
      const failures: string[] = [];
      const evidence: Record<string, unknown> = {};
      // Each load starts as a first visit: the page stores its resolved motion mode and would reuse it.
      await page.addInitScript(() => { try { localStorage.removeItem("masarx_motion"); } catch { /* storage blocked */ } });
      for (const target of PAGES[screenId]) {
        for (const stage of STAGES[screenId]) {
          const where = at(target, stage);
          // DESIGN.md section 9: the OS reduced-motion setting stops motion.
          await page.emulateMedia({ reducedMotion: "reduce" });
          await open(page, target, stage, "");
          if ((await page.locator("html").getAttribute("data-motion")) !== "off") failures.push(`${where}: reduced motion leaves data-motion on`);
          (await longMotion(page)).forEach((a) => failures.push(`${where}: ${a} runs under reduced motion`));
          // 2.2.2: motion that runs over 5 seconds by default needs a control on the page that stops it.
          await page.emulateMedia({ reducedMotion: "no-preference" });
          await open(page, target, stage, "");
          const running = await longMotion(page);
          const control = await page.locator("[data-motion-toggle]").count();
          evidence[where] = { running, control };
          if (!control) running.forEach((a) => failures.push(`${where}: ${a} runs over 5 s with no control to stop it`));
        }
      }
      expectRecorded(screenId, "reduced-motion", failures, evidence);
    });
  });
}
