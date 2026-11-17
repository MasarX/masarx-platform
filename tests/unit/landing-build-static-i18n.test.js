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
      LANDING_CONTACT_ENDPOINT: "https://example.com/contact",
      LANDING_CLIENTS_ENDPOINT: "https://example.com/clients",
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
    expect(headers).toContain("https://challenges.cloudflare.com");
    expect(runtimeJs).toContain('"clientsEndpoint":"https://example.com/clients"');
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
      LANDING_CONTACT_ENDPOINT: "https://example.com/contact",
      LANDING_CLIENTS_ENDPOINT: "https://example.com/clients",
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

  test("leaves runtime contactEndpoint empty when env is unset", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-build-default-demo-"));

    const env = {
      ...process.env,
      LANDING_SITE_URL: "https://example.com",
      LANDING_DOCS_URL: "https://example.com/docs",
      LANDING_APP_URL: "https://example.com/app",
      LANDING_CONTACT_ENDPOINT: "",
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

    expect(runtimeJs).toContain('"contactEndpoint":""');
    expect(runtimeJs).toContain('"clientsEndpoint":""');
  });
});
