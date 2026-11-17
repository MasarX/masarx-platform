import {
  normalizeAppBasePath,
  resolveRedirectTarget,
  stripLegacyRootAppPrefix,
} from "../../../packages/auth/src/redirect";

describe("auth redirect utilities", () => {
  test("strips legacy /console prefix from callback targets", () => {
    expect(stripLegacyRootAppPrefix("/console")).toBe("/");
    expect(stripLegacyRootAppPrefix("/console/workflows/queue")).toBe(
      "/workflows/queue"
    );
    expect(stripLegacyRootAppPrefix("/console/workflows/queue?tab=open#step-1")).toBe(
      "/workflows/queue?tab=open#step-1"
    );
  });

  test("strips legacy /portal prefix from callback targets", () => {
    expect(stripLegacyRootAppPrefix("/portal")).toBe("/");
    expect(stripLegacyRootAppPrefix("/portal/resources/shipments")).toBe(
      "/resources/shipments"
    );
  });

  test("normalizes app base path and removes legacy prefixes", () => {
    expect(normalizeAppBasePath("/")).toBe("/");
    expect(normalizeAppBasePath("")).toBe("/");
    expect(normalizeAppBasePath("console")).toBe("/");
    expect(normalizeAppBasePath("/console")).toBe("/");
    expect(normalizeAppBasePath("/console/")).toBe("/");
  });

  test("resolves same-origin callback next path safely and strips legacy prefix", () => {
    const requestUrl = new URL("https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback");
    const target = resolveRedirectTarget(
      requestUrl,
      "/console/observability/workflow-runs?status=failed",
      "/"
    );
    expect(target.toString()).toBe(
      "https://unjijvxjrwurjgsnokovrvom.example.invalid/observability/workflow-runs?status=failed"
    );
  });

  test("resolves absolute same-origin next path and strips legacy prefix", () => {
    const requestUrl = new URL("https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback");
    const target = resolveRedirectTarget(
      requestUrl,
      "https://unjijvxjrwurjgsnokovrvom.example.invalid/console/access-policy/request",
      "/"
    );
    expect(target.toString()).toBe(
      "https://unjijvxjrwurjgsnokovrvom.example.invalid/access-policy/request"
    );
  });

  test("falls back for cross-origin next path", () => {
    const requestUrl = new URL("https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback");
    const target = resolveRedirectTarget(
      requestUrl,
      "https://attacker.example/console/access",
      "/"
    );
    expect(target.toString()).toBe("https://unjijvxjrwurjgsnokovrvom.example.invalid/");
  });

  test("canonicalizes legacy fallback path to root", () => {
    const requestUrl = new URL("https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback");
    const target = resolveRedirectTarget(requestUrl, null, "/console");
    expect(target.toString()).toBe("https://unjijvxjrwurjgsnokovrvom.example.invalid/");
  });
});
