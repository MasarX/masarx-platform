import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { signingDocument } from "../../apps/portal/app/delivery-signing/signing-document";

const origin = "https://signing.example.invalid";
const url = `${origin}/delivery-signing`;
const nonce = "a".repeat(32);
const fixtureToken = "b".repeat(64);

test("accepts keyboard drawing, clears prior strokes, and keeps the token out of navigation", async ({ page }) => {
  const script = readFileSync(resolve(__dirname, "../../apps/portal/public/delivery-signing.js"), "utf8");
  const received: { url: string; token: string | undefined; png: string | undefined }[] = [];
  await page.route(`${origin}/delivery-signing.js`, (route) =>
    route.fulfill({ contentType: "text/javascript", body: script }));
  await page.route(url, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      received.push({
        url: request.url(),
        token: request.headers()["x-signing-token"],
        png: request.postDataBuffer()?.subarray(0, 8).toString("hex"),
      });
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: signingDocument(nonce),
      headers: { "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'` },
    });
  });

  await page.goto(`${url}#token=${fixtureToken}`);
  await expect(page).toHaveURL(url);
  const submit = page.getByRole("button", { name: "Submit signature" });
  await expect(submit).toBeDisabled();
  const pad = page.getByRole("application", { name: "Signature pad" });
  await pad.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.getByRole("button", { name: "Clear signature" }).click();
  await expect(submit).toBeDisabled();
  await pad.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  await submit.click();
  await expect(page.getByRole("status")).toHaveText("Signature received.");
  expect(received).toEqual([{ url, token: fixtureToken, png: "89504e470d0a1a0a" }]);
  await expect(submit).toBeDisabled();
});
