const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

describe("landing build", () => {
  test.each(["https://example.com/tenant-signup-intake", ""])("renders static i18n and keeps the explicit tenant endpoint (%s)", (tenantEndpoint) => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-build-"));

    const env = {
      ...process.env,
      LANDING_SITE_URL: "https://example.com",
      LANDING_DOCS_URL: "https://example.com/docs",
      LANDING_APP_URL: "https://example.com/app",
      LANDING_CONTACT_ENDPOINT: "https://example.com/contact",
      LANDING_TENANT_SIGNUP_ENDPOINT: tenantEndpoint,
      LANDING_CLIENTS_ENDPOINT: "https://example.com/clients",
      LANDING_DRIVER_APPLICATION_DOCUMENTS_ENDPOINT: "https://documents.example.test/return",
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

    expect(enHtml).toContain('data-tenant-signup-submit');
    expect(arHtml).toContain('data-tenant-signup-submit');
    expect(enHtml).toContain('name="request_context"');
    expect(arHtml).toContain('طلب تسجيل منظمة');
    expect(runtimeJs).toContain('https://example.com/contact');
    expect(enHtml).toContain('<html lang="en" dir="ltr"');
    expect(arHtml).toContain('<html lang="ar" dir="rtl"');
    expect(enHtml).toContain('data-i18n="nav_product">Product');
    expect(arHtml).not.toContain('data-i18n="nav_product">Product');
    expect(arHtml).toContain('data-i18n="cta_contact_sales">');
    expect(arHtml).not.toContain('data-i18n="cta_contact_sales">Contact sales');
    expect(enHtml).toContain('Every automated decision is logged with full context, giving operations teams a traceable audit trail.');
    expect(arHtml).toContain('يُسجَّل كل قرار تلقائي بسياقه الكامل، ما يمنح فرق العمليات سجل تدقيق قابلًا للتتبّع.');
    expect(enHtml).toContain('data-i18n="hero_h1">Connect delivery systems with configurable webhooks');
    expect(arHtml).toContain('data-i18n="hero_h1">اربط أنظمة التوصيل عبر Webhook قابل للإعداد');
    expect(enHtml).toContain('data-i18n="badge_minutes">Configurable webhook setup');
    expect(arHtml).toContain('data-i18n="badge_minutes">إعداد Webhook قابل للتخصيص');
    expect(enHtml).toContain('data-i18n="who_ops_1_title">Onboard clients with reusable mapping rules');
    expect(arHtml).toContain('data-i18n="who_ops_1_title">فعّل العملاء باستخدام قواعد ربط قابلة لإعادة الاستخدام');
    expect(enHtml).toContain('Integration time depends on your setup.');
    expect(arHtml).toContain('يعتمد وقت التكامل على إعداداتك.');
    expect(enHtml).not.toMatch(/(?:go live|onboard new clients|clients go live)[^<]{0,50}minutes/i);
    expect(arHtml).not.toMatch(/(?:التشغيل|عملاء)[^<]{0,50}دقائق/);
    expect(enHtml).not.toContain('quote-card');
    expect(arHtml).not.toContain('quote-card');
    expect(enHtml).not.toContain('60k+ monthly deliveries');
    expect(enHtml).toContain('Delivery fields matched — format detected');
    expect(arHtml).toContain('تمت مطابقة حقول التوصيل — تم كشف الصيغة');
    expect(enHtml).not.toMatch(/mapping_config|priority_express|mapping config/);
    expect(arHtml).not.toMatch(/mapping_config|priority_express/);
    expect(enHtml).toContain('data-driver-review-note aria-live="polite" hidden');
    for (const lang of ['', 'ar']) {
      const trackHtml = fs.readFileSync(path.join(outDir, lang, 'track', 'index.html'), 'utf8');
      expect(trackHtml).toMatch(/href="#lookup" data-track-requests-link data-i18n="track_nav_lookup"/);
      expect(trackHtml).not.toContain('href="#actions" data-i18n="track_nav_actions"');
    }

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
    expect(runtimeJs).toContain(`"tenantSignupEndpoint":${JSON.stringify(tenantEndpoint)}`);
    expect(runtimeJs).toContain('"contactEndpoint":"https://example.com/contact"');
    expect(headers).toContain("https://documents.example.test");
    expect(runtimeJs).toContain('"driverApplicationDocumentsEndpoint":"https://documents.example.test/return"');
    expect(enHtml).toContain('method="post" data-driver-documents-form hidden');
    expect(arHtml).toContain('data-i18n="driver_documents_abandon" hidden>إلغاء');
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
