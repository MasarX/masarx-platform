import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

test.describe("landing security headers", () => {
  let headersContent: string;

  test.beforeAll(() => {
    const headersPath = path.resolve(
      process.cwd(),
      process.env.LANDING_OUT_DIR || "dist/landing",
      "_headers"
    );

    headersContent = fs.readFileSync(headersPath, "utf8");
  });

  test("contains Content-Security-Policy with required directives", () => {
    expect(headersContent).toContain("Content-Security-Policy:");
    expect(headersContent).toContain("default-src 'self'");
    expect(headersContent).toContain("frame-ancestors 'none'");
    expect(headersContent).toContain("upgrade-insecure-requests");
  });

  test("contains Strict-Transport-Security", () => {
    expect(headersContent).toContain("Strict-Transport-Security:");
    expect(headersContent).toContain("max-age=63072000");
    expect(headersContent).toContain("includeSubDomains");
  });

  test("contains X-Frame-Options DENY", () => {
    expect(headersContent).toContain("X-Frame-Options: DENY");
  });

  test("contains Cross-Origin-Opener-Policy", () => {
    expect(headersContent).toContain("Cross-Origin-Opener-Policy: same-origin");
  });

  test("contains Cross-Origin-Embedder-Policy", () => {
    expect(headersContent).toContain("Cross-Origin-Embedder-Policy: credentialless");
  });

  test("contains X-Content-Type-Options", () => {
    expect(headersContent).toContain("X-Content-Type-Options: nosniff");
  });
});
