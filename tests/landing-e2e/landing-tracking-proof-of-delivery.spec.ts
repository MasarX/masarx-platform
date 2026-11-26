import { expect, test } from "@playwright/test";
import {
  LANDING_TRACKING_ENDPOINT_MOCK,
  mockTrackingEndpoint,
  patchRuntimeConfig,
  routePayload,
} from "./helpers";

const SESSION_KEY = "masarx_tracking_session_v1";
const FILE_PATH = "/functions/v1/public-shipment-tracking/proof/file";
// A 1x1 PNG; the file endpoint returns raster bytes.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function sessionPayload() {
  return {
    ok: true,
    tracking: {
      shipment: { tracking_number: "TRK-2026-0407", status: "delivered", service_type: "delivery" },
      timeline: [],
      actions: {},
      live_delivery: null,
    },
  };
}

function proofPayload() {
  const capturedAt = new Date(Date.now() - 600_000).toISOString();
  const link = (id: string) => `${FILE_PATH}?artifact=${id}&expires=1&signature=${"a".repeat(64)}`;
  return {
    ok: true,
    proof: {
      state: "available",
      available_until: new Date(Date.now() + 86_400_000).toISOString(),
      recipient_name: "S******",
      artifacts: [
        { kind: "photo", captured_at: capturedAt, url: link("photo-1") },
        { kind: "signature", captured_at: capturedAt, url: link("sig-1") },
      ],
    },
  };
}

test.describe("landing tracking proof of delivery", () => {
  test("shows proof tiles and the viewer dialog from a verified session in EN and AR", async ({ page }) => {
    const fileBodies: unknown[] = [];
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await page.addInitScript((key) => window.sessionStorage.setItem(key, "sess-proof-407"), SESSION_KEY);
    await page.route(`**${FILE_PATH}?**`, async (route) => {
      fileBodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    });
    await mockTrackingEndpoint(page, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/session")) {
        await routePayload(sessionPayload())(route);
        return;
      }
      if (url.pathname.endsWith("/proof")) {
        await routePayload(proofPayload())(route);
        return;
      }
      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    for (const [path, lang, openPhoto, close, photoTitle] of [
      ["/track/?motion=off", "en", /^Open delivery photo, /, "Close", "Delivery photo"],
      ["/ar/track/?motion=off", "ar", /^افتح صورة التسليم، /, "إغلاق", "صورة التسليم"],
    ] as const) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      const card = page.locator("[data-track-proof]");
      await expect(card).toBeVisible();
      const photo = card.getByRole("button", { name: openPhoto });
      await expect(photo).toBeVisible();
      await expect(card.locator("button.pod-thumb")).toHaveCount(2);
      await expect(card.locator("[data-track-proof-meta] bdi")).not.toBeEmpty();

      await photo.click();
      const dialog = page.getByRole("dialog", { name: photoTitle });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: close })).toBeFocused();
      await expect(dialog.locator("[data-track-proof-dialog-image]")).toHaveAttribute("src", /^blob:/);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(photo).toBeFocused();
    }

    expect(fileBodies).toEqual(Array(4).fill({ session_token: "sess-proof-407" }));
  });
});
