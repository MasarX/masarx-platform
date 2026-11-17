import { test, expect } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

test("FieldOps web shell is installable and fits a mobile viewport", async ({ page, baseURL }) => {
  await page.goto("./");
  await expect(page.getByTestId("mobile-signin-screen")).toBeVisible();
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestHref).toBeTruthy();
  const response = await page.request.get(new URL(manifestHref!, page.url()).href);
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("./");
  for (const icon of manifest.icons) {
    expect((await page.request.get(new URL(icon.src, page.url()).href)).ok()).toBe(true);
  }
  expect(await page.locator('link[rel="apple-touch-icon"]').count()).toBe(1);
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)).toBe(baseURL);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
});

test("FieldOps public shell can reload offline without caching API responses", async ({ page, baseURL }) => {
  // WebKit setOffline rejects even literal SW responses (Playwright #42775).
  // Stop this test's own origin instead: real transport failure, no fake pass.
  const exportDir = process.env.FIELDOPS_WEB_EXPORT_DIR;
  if (!exportDir) throw new Error("Offline artifact smoke requires FIELDOPS_WEB_EXPORT_DIR.");
  const root = path.resolve(exportDir);
  const prefix = new URL(baseURL!).pathname;
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (!pathname.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const relativePath = pathname.slice(prefix.length);
    const file = path.resolve(root, relativePath || "index.html");
    if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const mime = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json" };
    response.writeHead(200, { "content-type": mime[path.extname(file) as keyof typeof mime] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Artifact origin did not start.");
  try {
    await page.goto(`http://127.0.0.1:${address.port}${prefix}`);
    await expect(page.getByTestId("mobile-signin-screen")).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    const response = await page.request.get(page.url()).catch(() => null);
    expect(response).toBeNull(); // Origin really is unavailable.
    await page.reload();
    await expect(page.getByTestId("mobile-signin-screen")).toBeVisible();
    const cachedUrls = await page.evaluate(async () => {
      const scope = new URL((await navigator.serviceWorker.ready).scope).pathname;
      const cache = await caches.open(scope === "/" ? "fieldops-shell-v1" : `fieldops-shell-v1:${encodeURIComponent(scope)}`);
      return (await cache.keys()).map((request) => request.url);
    });
    expect(cachedUrls.every((value) => {
      const url = new URL(value);
      return url.pathname.startsWith(prefix) && !url.search && !/\/(auth|rest|functions)\//.test(url.pathname);
    })).toBe(true);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  }
});
