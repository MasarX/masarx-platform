const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

describe("landing build", () => {
  test("renders static i18n for /ar/ with root-absolute assets", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-build-"));

    const env = {
      ...process.env,
      LANDING_SITE_URL: "https://example.com",
      LANDING_DOCS_URL: "https://example.com/docs",
      LANDING_APP_URL: "https://example.com/app",
      LANDING_CONTACT_ENDPOINT: "https://example.com/functions/v1/marketing-lead-intake",
      LANDING_TENANT_SIGNUP_ENDPOINT: "https://example.com/functions/v1/tenant-signup-intake",
      LANDING_DRIVER_SIGNUP_ENDPOINT: "https://drivers.example.com/signup",
      LANDING_DRIVER_APPLICATION_STATUS_ENDPOINT: "",
      LANDING_DRIVER_STATUS_ENDPOINT: "https://drivers.example.com/status",
      LANDING_CLIENTS_ENDPOINT: "https://example.com/functions/v1/marketing-lead-intake/clients",
      LANDING_TURNSTILE_SITE_KEY: "0x4AAAAAAA",
    };

    const res = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "frontend", "build-landing.js"), "--out", outDir],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      }
    );

    if (res.status !== 0) {
      const stderr = res.stderr ? `\n${res.stderr}` : "";
      throw new Error(`build-landing.js failed (code=${res.status})${stderr}`);
    }

    const arHtml = fs.readFileSync(path.join(outDir, "ar", "index.html"), "utf8");
    const enHtml = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
    const headers = fs.readFileSync(path.join(outDir, "_headers"), "utf8");
    const runtimeFile = fs
      .readdirSync(outDir)
      .find((name) => /^runtime\.[a-f0-9]{8}\.js$/.test(name));
    const runtimeJs = runtimeFile ? fs.readFileSync(path.join(outDir, runtimeFile), "utf8") : "";

    expect(enHtml).toContain('<html lang="en" dir="ltr"');
    expect(arHtml).toContain('<html lang="ar" dir="rtl"');
    expect(enHtml).toContain('data-i18n="nav_product">Product');
    expect(arHtml).not.toContain('data-i18n="nav_product">Product');
    expect(arHtml).toContain('data-i18n="cta_contact_sales">');
    expect(arHtml).not.toContain('data-i18n="cta_contact_sales">Contact sales');
    expect(arHtml).toContain("لحل الأسئلة بسرعة");
    expect(arHtml).not.toContain("تتبّع أي مشكلة");

    expect(enHtml).toMatch(/href="\/app\.[a-f0-9]{8}\.css"/);
    expect(arHtml).toMatch(/href="\/app\.[a-f0-9]{8}\.css"/);
    expect(enHtml).toMatch(/src="\/runtime\.[a-f0-9]{8}\.js"/);
    expect(arHtml).toMatch(/src="\/runtime\.[a-f0-9]{8}\.js"/);
    expect(enHtml).toContain('src="/brand/masarx-mark-a.svg"');
    expect(arHtml).toContain('src="/brand/masarx-mark-a.svg"');
    expect(enHtml).not.toContain('data-clients-row');
    expect(arHtml).not.toContain('href="./app.');
    expect(arHtml).not.toContain('src="./app.');
    expect(arHtml).not.toContain('src="./runtime.');
    expect(arHtml).not.toContain('src="./brand/');

    expect(headers).toContain("connect-src");
    expect(headers).toContain("https://example.com");
    expect(headers).toContain("https://drivers.example.com");
    expect(headers).toContain("https://challenges.cloudflare.com");
    expect(runtimeJs).toContain('"clientsEndpoint":"https://example.com/functions/v1/marketing-lead-intake/clients"');
    expect(runtimeJs).toContain('"tenantSignupEndpoint":"https://example.com/functions/v1/tenant-signup-intake"');
    expect(runtimeJs).toContain('"driverSignupEndpoint":"https://drivers.example.com/signup"');
    expect(runtimeJs).toContain('"driverApplicationStatusEndpoint":"https://drivers.example.com/status"');
    expect(headers).toContain("/*.js");
  });

  test("scopes asset URLs to LANDING_SITE_URL subpath", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-build-subpath-"));

    const env = {
      ...process.env,
      LANDING_SITE_URL: "https://example.com/landing",
      LANDING_DOCS_URL: "https://example.com/docs",
      LANDING_APP_URL: "https://example.com/app",
      LANDING_CONTACT_ENDPOINT: "https://example.com/functions/v1/marketing-lead-intake",
      LANDING_TENANT_SIGNUP_ENDPOINT: "https://example.com/functions/v1/tenant-signup-intake",
      LANDING_CLIENTS_ENDPOINT: "https://example.com/functions/v1/marketing-lead-intake/clients",
      LANDING_TURNSTILE_SITE_KEY: "0x4AAAAAAA",
    };

    const res = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "frontend", "build-landing.js"), "--out", outDir],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      }
    );

    if (res.status !== 0) {
      const stderr = res.stderr ? `\n${res.stderr}` : "";
      throw new Error(`build-landing.js failed (code=${res.status})${stderr}`);
    }

    const arHtml = fs.readFileSync(path.join(outDir, "ar", "index.html"), "utf8");
    expect(arHtml).toMatch(/href="\/landing\/app\.[a-f0-9]{8}\.css"/);
    expect(arHtml).toMatch(/src="\/landing\/runtime\.[a-f0-9]{8}\.js"/);
    expect(arHtml).toContain('src="/landing/brand/masarx-mark-a.svg"');
    expect(arHtml).toContain("data-clients-row");
  });

  test("rejects missing contact endpoint for landing builds", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-build-missing-contact-"));

    const env = {
      ...process.env,
      LANDING_SITE_URL: "https://example.com",
      LANDING_DOCS_URL: "https://example.com/docs",
      LANDING_APP_URL: "https://example.com/app",
      LANDING_CONTACT_ENDPOINT: "",
      LANDING_TENANT_SIGNUP_ENDPOINT: "",
      LANDING_DRIVER_SIGNUP_ENDPOINT: "",
      LANDING_DRIVER_APPLICATION_STATUS_ENDPOINT: "",
      LANDING_DRIVER_STATUS_ENDPOINT: "",
      LANDING_TRACKING_ENDPOINT: "",
      LANDING_CLIENTS_ENDPOINT: "",
      LANDING_TURNSTILE_SITE_KEY: "",
    };

    const res = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "frontend", "build-landing.js"), "--out", outDir],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      }
    );

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("LANDING_CONTACT_ENDPOINT is required for landing builds");
  });

  test("rejects missing tenant signup endpoint for landing builds", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-build-missing-tenant-signup-"));

    const env = {
      ...process.env,
      LANDING_SITE_URL: "https://example.com",
      LANDING_DOCS_URL: "https://example.com/docs",
      LANDING_APP_URL: "https://example.com/app",
      LANDING_CONTACT_ENDPOINT: "https://example.com/functions/v1/marketing-lead-intake",
      LANDING_TENANT_SIGNUP_ENDPOINT: "",
      LANDING_DRIVER_SIGNUP_ENDPOINT: "",
      LANDING_DRIVER_APPLICATION_STATUS_ENDPOINT: "",
      LANDING_DRIVER_STATUS_ENDPOINT: "",
      LANDING_TRACKING_ENDPOINT: "",
      LANDING_CLIENTS_ENDPOINT: "",
      LANDING_TURNSTILE_SITE_KEY: "",
    };

    const res = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "frontend", "build-landing.js"), "--out", outDir],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      }
    );

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("LANDING_TENANT_SIGNUP_ENDPOINT is required for landing builds");
  });

  test("derives clientsEndpoint only from marketing lead intake when explicit env is unset", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-build-clients-feed-"));

    const env = {
      ...process.env,
      LANDING_SITE_URL: "https://example.com",
      LANDING_DOCS_URL: "https://example.com/docs",
      LANDING_APP_URL: "https://example.com/app",
      LANDING_CONTACT_ENDPOINT: "https://example.com/functions/v1/marketing-lead-intake",
      LANDING_TENANT_SIGNUP_ENDPOINT: "https://example.com/functions/v1/tenant-signup-intake",
      LANDING_CLIENTS_ENDPOINT: "",
      LANDING_TURNSTILE_SITE_KEY: "",
    };

    const res = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "frontend", "build-landing.js"), "--out", outDir],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      }
    );

    if (res.status !== 0) {
      const stderr = res.stderr ? `\n${res.stderr}` : "";
      throw new Error(`build-landing.js failed (code=${res.status})${stderr}`);
    }

    const runtimeFile = fs
      .readdirSync(outDir)
      .find((name) => /^runtime\.[a-f0-9]{8}\.js$/.test(name));
    const runtimeJs = runtimeFile ? fs.readFileSync(path.join(outDir, runtimeFile), "utf8") : "";

    expect(runtimeJs).toContain(
      '"clientsEndpoint":"https://example.com/functions/v1/marketing-lead-intake/clients"'
    );
    expect(runtimeJs).not.toContain("tenant-signup-intake/clients");
  });

  test("supports canonical relative landing intake endpoints", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-build-relative-endpoints-"));

    const env = {
      ...process.env,
      LANDING_SITE_URL: "https://example.com",
      LANDING_DOCS_URL: "https://example.com/docs",
      LANDING_APP_URL: "https://example.com/app",
      LANDING_CONTACT_ENDPOINT: "/functions/v1/marketing-lead-intake",
      LANDING_TENANT_SIGNUP_ENDPOINT: "/functions/v1/tenant-signup-intake",
      LANDING_CLIENTS_ENDPOINT: "",
      LANDING_TURNSTILE_SITE_KEY: "",
    };

    const res = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "frontend", "build-landing.js"), "--out", outDir],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      }
    );

    if (res.status !== 0) {
      const stderr = res.stderr ? `\n${res.stderr}` : "";
      throw new Error(`build-landing.js failed (code=${res.status})${stderr}`);
    }

    const runtimeFile = fs
      .readdirSync(outDir)
      .find((name) => /^runtime\.[a-f0-9]{8}\.js$/.test(name));
    const runtimeJs = runtimeFile ? fs.readFileSync(path.join(outDir, runtimeFile), "utf8") : "";

    expect(runtimeJs).toContain('"contactEndpoint":"/functions/v1/marketing-lead-intake"');
    expect(runtimeJs).toContain('"tenantSignupEndpoint":"/functions/v1/tenant-signup-intake"');
    expect(runtimeJs).toContain('"clientsEndpoint":"/functions/v1/marketing-lead-intake/clients"');
  });

  test("supports existing local preview mock endpoints for local landing builds", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-build-local-preview-endpoints-"));

    const env = {
      ...process.env,
      LANDING_SITE_URL: "http://127.0.0.1:3333",
      LANDING_DOCS_URL: "https://example.com/docs",
      LANDING_APP_URL: "https://example.com/app",
      LANDING_CONTACT_ENDPOINT: "/__landing-contact",
      LANDING_TENANT_SIGNUP_ENDPOINT: "/__tenant-signup",
      LANDING_CLIENTS_ENDPOINT: "",
      LANDING_TURNSTILE_SITE_KEY: "",
    };

    const res = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "frontend", "build-landing.js"), "--out", outDir],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      }
    );

    if (res.status !== 0) {
      const stderr = res.stderr ? `\n${res.stderr}` : "";
      throw new Error(`build-landing.js failed (code=${res.status})${stderr}`);
    }

    const runtimeFile = fs
      .readdirSync(outDir)
      .find((name) => /^runtime\.[a-f0-9]{8}\.js$/.test(name));
    const runtimeJs = runtimeFile ? fs.readFileSync(path.join(outDir, runtimeFile), "utf8") : "";

    expect(runtimeJs).toContain('"contactEndpoint":"/__landing-contact"');
    expect(runtimeJs).toContain('"tenantSignupEndpoint":"/__tenant-signup"');
    expect(runtimeJs).toContain('"clientsEndpoint":""');
  });

  test("rejects contact endpoint values outside the marketing lead intake facade", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-build-invalid-contact-endpoint-"));

    const env = {
      ...process.env,
      LANDING_SITE_URL: "https://example.com",
      LANDING_DOCS_URL: "https://example.com/docs",
      LANDING_APP_URL: "https://example.com/app",
      LANDING_CONTACT_ENDPOINT: "https://example.com/functions/v1/tenant-signup-intake",
      LANDING_TENANT_SIGNUP_ENDPOINT: "https://example.com/functions/v1/tenant-signup-intake",
      LANDING_CLIENTS_ENDPOINT: "https://example.com/functions/v1/marketing-lead-intake/clients",
      LANDING_TURNSTILE_SITE_KEY: "",
    };

    const res = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "frontend", "build-landing.js"), "--out", outDir],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      }
    );

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain(
      "LANDING_CONTACT_ENDPOINT must point to the marketing-lead-intake intake endpoint"
    );
  });

  test("rejects tenant signup endpoint values outside tenant-signup-intake", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-build-invalid-tenant-endpoint-"));

    const env = {
      ...process.env,
      LANDING_SITE_URL: "https://example.com",
      LANDING_DOCS_URL: "https://example.com/docs",
      LANDING_APP_URL: "https://example.com/app",
      LANDING_CONTACT_ENDPOINT: "https://example.com/functions/v1/marketing-lead-intake",
      LANDING_TENANT_SIGNUP_ENDPOINT: "https://example.com/functions/v1/marketing-lead-intake",
      LANDING_CLIENTS_ENDPOINT: "https://example.com/functions/v1/marketing-lead-intake/clients",
      LANDING_TURNSTILE_SITE_KEY: "",
    };

    const res = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "frontend", "build-landing.js"), "--out", outDir],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      }
    );

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain(
      "LANDING_TENANT_SIGNUP_ENDPOINT must point to the tenant-signup-intake intake endpoint"
    );
  });

  test("rejects clientsEndpoint values outside the marketing lead clients feed", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-build-invalid-clients-feed-"));

    const env = {
      ...process.env,
      LANDING_SITE_URL: "https://example.com",
      LANDING_DOCS_URL: "https://example.com/docs",
      LANDING_APP_URL: "https://example.com/app",
      LANDING_CONTACT_ENDPOINT: "https://example.com/functions/v1/marketing-lead-intake",
      LANDING_TENANT_SIGNUP_ENDPOINT: "https://example.com/functions/v1/tenant-signup-intake",
      LANDING_CLIENTS_ENDPOINT: "https://example.com/functions/v1/tenant-signup-intake/clients",
      LANDING_TURNSTILE_SITE_KEY: "",
    };

    const res = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "frontend", "build-landing.js"), "--out", outDir],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      }
    );

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain(
      "LANDING_CLIENTS_ENDPOINT must point to the marketing-lead-intake clients feed"
    );
  });
});
