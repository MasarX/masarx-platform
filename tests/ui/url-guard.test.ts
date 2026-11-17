jest.mock("@masarx/auth", () => ({}));
jest.mock("@masarx/api/server", () => ({}));

import { resolveSafeHref as resolvePublicSafeHref } from "@masarx/ui";
import {
  resolveSafeAppBasePath,
  resolveSafeHref,
  isLoopbackHostname,
  isTrustedDownloadUrl,
  isTrustedUrl,
  openTrustedInNewTab,
  safeDownloadUrls,
  resolveBaseOrigin,
  isTrustedExternalDataUrl,
  resolveTrustedExternalDataOrigins,
  resolveTrustedExternalDataUrl,
  resolveTrustedOperationDocUrl,
} from "../../packages/ui/src/url-guard";

const loopbackHostnameContract = require("../fixtures/loopback-hostname-contract.json") as {
  accepted: string[];
  rejected: string[];
};

test("the supported UI entry point exports the existing safe-link helper unchanged", () => {
  expect(resolvePublicSafeHref).toBe(resolveSafeHref);
});

test("url guard follows the canonical loopback hostname contract", () => {
  for (const hostname of loopbackHostnameContract.accepted) {
    expect(isLoopbackHostname(hostname)).toBe(true);
  }
  for (const hostname of loopbackHostnameContract.rejected) {
    expect(isLoopbackHostname(hostname)).toBe(false);
  }
});

test("url guard rejects unsafe schemes and protocol-relative URLs by default", () => {
  expect(isTrustedUrl("https://example.com/object.csv")).toBe(true);
  expect(isTrustedUrl("/internal/detail")).toBe(true);
  expect(isTrustedUrl("javascript:alert(1)")).toBe(false);
  expect(isTrustedUrl("data:text/plain,boom")).toBe(false);
  expect(isTrustedUrl("ftp://example.com/file")).toBe(false);
  expect(isTrustedUrl("//example.com/object.csv")).toBe(false);
  expect(isTrustedUrl("/\\example.com/object.csv")).toBe(false);
  expect(isTrustedUrl("/\texample.com/object.csv")).toBe(false);
  expect(
    isTrustedUrl(String.raw`https:\\example.com\object.csv`)
  ).toBe(false);
  expect(isTrustedUrl("\u0000https://example.com/object.csv")).toBe(false);
  expect(isTrustedUrl("https://example.com/object.csv\u001f")).toBe(false);
  expect(isTrustedUrl("\u007f/internal/detail")).toBe(false);
});

test("url guard supports optional download host allowlist", () => {
  const allowlist = new Set(["storage.example.com"]);
  expect(
    isTrustedDownloadUrl("https://storage.example.com/object.csv", allowlist)
  ).toBe(true);
  expect(
    isTrustedDownloadUrl("https://api.example.com/object.csv", allowlist)
  ).toBe(false);
  expect(
    isTrustedDownloadUrl("http://storage.example.com/object.csv", allowlist)
  ).toBe(false);
  expect(
    isTrustedDownloadUrl("https://olzrzvwzgsjmugutosxjnkix@example.invalid/object.csv", allowlist)
  ).toBe(false);
  expect(isTrustedDownloadUrl("/downloads/object.csv", allowlist)).toBe(true);
  expect(safeDownloadUrls(["https://storage.example.com/a", "javascript:alert(1)"], allowlist)).toEqual([
    "https://storage.example.com/a",
  ]);
});

test("external data url guard requires an exact trusted origin", () => {
  const allowlist = new Set(["https://storage.example.com:8443"]);

  expect(
    resolveTrustedExternalDataUrl(
      "https://storage.example.com:8443/object.csv",
      allowlist
    )
  ).toBe("https://storage.example.com:8443/object.csv");
  expect(isTrustedExternalDataUrl("/downloads/object.csv", allowlist)).toBe(
    true
  );
  expect(
    isTrustedExternalDataUrl("https://storage.example.com/object.csv", allowlist)
  ).toBe(false);
  expect(
    isTrustedExternalDataUrl(
      "http://storage.example.com:8443/object.csv",
      new Set(["http://storage.example.com:8443"])
    )
  ).toBe(false);
  expect(
    isTrustedExternalDataUrl(
      "http://localhost:54321/object.csv",
      new Set(["http://localhost:54321"])
    )
  ).toBe(true);
  expect(
    isTrustedExternalDataUrl(
      "https://storage.example.com.evil.test:8443/object.csv",
      allowlist
    )
  ).toBe(false);
  expect(
    isTrustedExternalDataUrl(
      "https://olzrzvwzgsjmugutosxjnkix@example.invalid:8443/object.csv",
      allowlist
    )
  ).toBe(false);
  expect(
    isTrustedExternalDataUrl("//storage.example.com:8443/object.csv", allowlist)
  ).toBe(false);
  expect(
    isTrustedExternalDataUrl("/\\storage.example.com:8443/object.csv", allowlist)
  ).toBe(false);
  expect(
    isTrustedExternalDataUrl("/\nstorage.example.com:8443/object.csv", allowlist)
  ).toBe(false);
  expect(
    resolveTrustedExternalDataUrl(
      String.raw`https:\\storage.example.com:8443\object.csv`,
      allowlist
    )
  ).toBeNull();
  expect(
    resolveTrustedExternalDataUrl(
      "\u0000https://storage.example.com:8443/object.csv",
      allowlist
    )
  ).toBeNull();
  expect(
    resolveTrustedExternalDataUrl(
      "https://storage.example.com:8443/object.csv\u007f",
      allowlist
    )
  ).toBeNull();
  expect(
    resolveTrustedExternalDataUrl(
      "https://storage.example.com:8443/object.csv",
      allowlist
    )
  ).toBe("https://storage.example.com:8443/object.csv");
});

test("operation docs require same-app paths or an exact configured origin", () => {
  const allowlist = new Set(["https://docs.example.com"]);

  expect(resolveTrustedOperationDocUrl("docs/operations", allowlist)).toBe(
    "/docs/operations"
  );
  expect(resolveTrustedOperationDocUrl("/docs/operations", allowlist)).toBe(
    "/docs/operations"
  );
  expect(
    resolveTrustedOperationDocUrl(
      "https://docs.example.com/operations",
      allowlist
    )
  ).toBe("https://docs.example.com/operations");
  expect(
    resolveTrustedOperationDocUrl(
      "https://docs.example.com.evil.test/operations",
      allowlist
    )
  ).toBeNull();
  expect(
    resolveTrustedOperationDocUrl("/\\evil.test/operations", allowlist)
  ).toBeNull();
  expect(
    resolveTrustedOperationDocUrl("/\tevil.test/operations", allowlist)
  ).toBeNull();
});

test("external data origins resolve lazily from public configuration", () => {
  const previousSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousConfiguredOrigins =
    process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS;
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS =
      "https://cdn.example.com, https://cdn.example.com/, https://files.example.com:8443, http://localhost:54321, http://cdn-cleartext.example.com, https://ropuigqyklxliwvgywhshqyv@example.invalid, https://bad.example.com/path";

    expect([...resolveTrustedExternalDataOrigins()]).toEqual([
      "https://project.supabase.co",
      "https://cdn.example.com",
      "https://files.example.com:8443",
      "http://localhost:54321",
    ]);
    expect(isTrustedExternalDataUrl("https://cdn.example.com/file.pdf")).toBe(
      true
    );
    expect(isTrustedExternalDataUrl("http://localhost:54321/file.pdf")).toBe(
      true
    );
    expect(
      isTrustedExternalDataUrl("http://cdn-cleartext.example.com/file.pdf")
    ).toBe(false);

    process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS =
      "https://other.example.com";
    expect(isTrustedExternalDataUrl("https://cdn.example.com/file.pdf")).toBe(
      false
    );
    expect(isTrustedExternalDataUrl("https://other.example.com/file.pdf")).toBe(
      true
    );
  } finally {
    if (previousSupabaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = previousSupabaseUrl;
    }
    if (previousConfiguredOrigins === undefined) {
      delete process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS;
    } else {
      process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS =
        previousConfiguredOrigins;
    }
  }
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
  expect(resolveSafeAppBasePath("/\\evil.test")).toBeNull();
  expect(resolveSafeAppBasePath("/\tevil.test")).toBeNull();
  expect(resolveSafeAppBasePath("\u0000/console")).toBeNull();
  expect(resolveSafeAppBasePath("/console\u007f")).toBeNull();
});

test("resolveSafeHref rejects paths when appBasePath is not safe", () => {
  expect(resolveSafeHref("https://evil.com", "/foo")).toBeNull();
  expect(resolveSafeHref("console", "/foo")).toBeNull();
  expect(resolveSafeHref("", "/foo")).toBe("/foo");
  expect(resolveSafeHref(" /", "/foo")).toBe("/foo");
  expect(resolveSafeHref("/", "/foo")).toBe("/foo");
  expect(resolveSafeHref("", "/\\evil.test/foo")).toBeNull();
  expect(resolveSafeHref("", "/\tevil.test/foo")).toBeNull();
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
