import { resolveAppBasePath } from "../../apps/shared/app-base-path";

describe("resolveAppBasePath", () => {
  const originalEnv = process.env.NEXT_PUBLIC_APP_BASE_PATH;
  const appDir = "/workspace/apps/console";

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NEXT_PUBLIC_APP_BASE_PATH;
    } else {
      process.env.NEXT_PUBLIC_APP_BASE_PATH = originalEnv;
    }
  });

  test("falls back to host-root when env is unset", () => {
    delete process.env.NEXT_PUBLIC_APP_BASE_PATH;
    expect(resolveAppBasePath(appDir)).toBe("");
  });

  test("uses a trusted app base path when configured", () => {
    process.env.NEXT_PUBLIC_APP_BASE_PATH = "/portal";
    expect(resolveAppBasePath(appDir)).toBe("/portal");
  });

  test("normalizes a trailing slash on a safe configured base path", () => {
    process.env.NEXT_PUBLIC_APP_BASE_PATH = "/portal/";
    expect(resolveAppBasePath(appDir)).toBe("/portal");
  });

  test("rejects unsafe base paths and falls back to host-root", () => {
    process.env.NEXT_PUBLIC_APP_BASE_PATH = "javascript:alert(1)";
    expect(resolveAppBasePath(appDir)).toBe("");
  });

  test("rejects protocol-relative base paths and falls back to host-root", () => {
    process.env.NEXT_PUBLIC_APP_BASE_PATH = "//portal";
    expect(resolveAppBasePath(appDir)).toBe("");
  });
});
