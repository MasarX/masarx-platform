import {
  resolveSafeAppBasePath,
  resolveSafeHref,
  isTrustedDownloadUrl,
  isTrustedUrl,
  openTrustedInNewTab,
  safeDownloadUrls,
  resolveBaseOrigin,
} from "../../packages/ui/src/url-guard";

test("url guard rejects unsafe schemes and protocol-relative URLs by default", () => {
  expect(isTrustedUrl("https://example.com/object.csv")).toBe(true);
  expect(isTrustedUrl("/internal/detail")).toBe(true);
  expect(isTrustedUrl("javascript:alert(1)")).toBe(false);
  expect(isTrustedUrl("data:text/plain,boom")).toBe(false);
  expect(isTrustedUrl("ftp://example.com/file")).toBe(false);
  expect(isTrustedUrl("//example.com/object.csv")).toBe(false);
});

test("url guard supports optional download host allowlist", () => {
  const allowlist = new Set(["storage.example.com"]);
  expect(
    isTrustedDownloadUrl("https://storage.example.com/object.csv", allowlist)
  ).toBe(true);
  expect(
    isTrustedDownloadUrl("https://api.example.com/object.csv", allowlist)
  ).toBe(false);
  expect(isTrustedDownloadUrl("/downloads/object.csv", allowlist)).toBe(true);
  expect(safeDownloadUrls(["https://storage.example.com/a", "javascript:alert(1)"], allowlist)).toEqual([
    "https://storage.example.com/a",
  ]);
});

test("openTrustedInNewTab opens trusted URLs and blocks unsafe URLs", () => {
  const openMock = jest.spyOn(window, "open").mockReturnValue({
    location: null,
  } as any);

  const trusted = openTrustedInNewTab("/console/workflows/runs/123#outputs");
  expect(trusted).toBeTruthy();
  expect(openMock).toHaveBeenCalledWith(
    "/console/workflows/runs/123#outputs",
    "_blank",
    "noopener,noreferrer"
  );

  const blocked = openTrustedInNewTab("javascript:alert(1)");
  expect(blocked).toBeNull();
  expect(openMock).toHaveBeenCalledTimes(1);

  openMock.mockRestore();
});

test("safe app base path helper only accepts trusted relative paths", () => {
  expect(resolveSafeAppBasePath("/console")).toBe("/console");
  expect(resolveSafeAppBasePath("/console/")).toBe("/console");
  expect(resolveSafeAppBasePath("/")).toBe("");
  expect(resolveSafeAppBasePath("")).toBe("");
  expect(resolveSafeAppBasePath("https://evil.com")).toBeNull();
  expect(resolveSafeAppBasePath("//console")).toBeNull();
  expect(resolveSafeAppBasePath("console")).toBeNull();
  expect(resolveSafeAppBasePath("/foo bar")).toBeNull();
});

test("resolveSafeHref rejects paths when appBasePath is not safe", () => {
  expect(resolveSafeHref("https://evil.com", "/foo")).toBeNull();
  expect(resolveSafeHref("console", "/foo")).toBeNull();
  expect(resolveSafeHref("", "/foo")).toBe("/foo");
  expect(resolveSafeHref(" /", "/foo")).toBe("/foo");
  expect(resolveSafeHref("/", "/foo")).toBe("/foo");
});

test("resolveBaseOrigin resolves dynamic app/site env values server-side", () => {
  const originalWindow = globalThis.window;
  // @ts-ignore force server-side branch
  delete (globalThis as { window?: typeof globalThis.window }).window;

  const restoreEnv = { ...process.env };
  (process.env as Record<string, string | undefined>).NEXT_PUBLIC_APP_URL =
    "https://mxgzhvvmhopkvhhssoiqzznk.example.invalid";

  expect(resolveBaseOrigin()).toBe("https://mxgzhvvmhopkvhhssoiqzznk.example.invalid");

  delete process.env.NEXT_PUBLIC_APP_URL;
  (process.env as Record<string, string | undefined>).NEXT_PUBLIC_SITE_URL =
    "lyqghymkjylygrvizzrhzoiz.example.invalid";
  expect(resolveBaseOrigin()).toBe("https://lyqghymkjylygrvizzrhzoiz.example.invalid");

  delete process.env.NEXT_PUBLIC_SITE_URL;
  (process.env as Record<string, string | undefined>).VERCEL_URL = "my.vercel.app";
  expect(resolveBaseOrigin()).toBe("https://my.vercel.app");

  delete process.env.VERCEL_URL;
  expect(resolveBaseOrigin()).toBe("https://example.invalid");

  (globalThis as { window?: typeof globalThis.window }).window = originalWindow;
  process.env = restoreEnv;
});
