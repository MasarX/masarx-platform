const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prunePreviewDeployments } = require("../../../scripts/frontend/prune-landing-previews");
const test = globalThis.test ?? require("node:test").test;

const repo = path.resolve(__dirname, "../../..");
const devUrl = "https://dev.example.invalid";
const otherUrl = "https://other.example.invalid";
const intake = {
  LANDING_CONTACT_ENDPOINT: `${devUrl}/marketing-lead-intake`,
  LANDING_TENANT_SIGNUP_ENDPOINT: `${devUrl}/tenant-signup-intake`,
  LANDING_DRIVER_SIGNUP_ENDPOINT: `${devUrl}/signup`,
  LANDING_DRIVER_APPLICATION_STATUS_ENDPOINT: `${devUrl}/status`,
  LANDING_DRIVER_APPLICATION_DOCUMENTS_ENDPOINT: `${devUrl}/documents`,
  LANDING_TRACKING_ENDPOINT: `${devUrl}/tracking`,
  LANDING_CLIENTS_ENDPOINT: `${devUrl}/marketing-lead-intake/clients`,
};

function withBuild(env, check) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "landing-dev-test-"));
  try {
    const result = spawnSync(process.execPath, ["scripts/frontend/build-landing.js", "--out", out], {
      cwd: repo,
      env: {
        ...process.env,
        ENV_FILE: "",
        LANDING_SITE_URL: "https://landing.example.invalid",
        LANDING_DRIVER_STATUS_ENDPOINT: "",
        NEXT_PUBLIC_SUPABASE_URL: devUrl,
        ...intake,
        ...env,
      },
      encoding: "utf8",
    });
    check(result, (file) => fs.readFileSync(path.join(out, file), "utf8"));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

for (const env of ["dev", "stg", "prod"]) {
  test(`landing robots rules and localized warnings in ${env}`, () => {
    withBuild({
      DEPLOY_ENV: env,
      ...(env === "dev" ? {} : { LANDING_CONTACT_ENDPOINT: `${otherUrl}/marketing-lead-intake` }),
    }, (result, read) => {
      assert.equal(result.status, 0, result.stderr);
      const expected = env === "dev";
      const headers = read("_headers");
      assert.equal(headers.includes("  X-Robots-Tag: noindex, nofollow\n"), expected);
      assert.match(headers, /Content-Security-Policy:/);
      for (const [prefix, notice] of [
        ["", "Test environment: do not enter real personal data."],
        ["ar/", "بيئة اختبار: لا تُدخل بيانات شخصية حقيقية."],
      ]) {
        for (const route of ["", "track/", "drivers/", "drivers/apply/", "drivers/status/"]) {
          const html = read(`${prefix}${route}index.html`);
          assert.equal(html.includes('<meta name="robots" content="noindex, nofollow">'), expected);
          const forms = [...html.matchAll(/<form\b/g)];
          const notices = [...html.matchAll(
            /<p id="(dev-form-notice-\d+)" class="dev-form-notice" data-i18n="dev_form_notice">([^<]+)<\/p>\s*<form\b[^>]*aria-describedby="\1"/g
          )];
          assert.equal(forms.length, 4);
          assert.equal(notices.length, expected ? forms.length : 0);
          assert.equal(html.includes("dev_form_notice"), expected);
          assert.ok(!html.includes("dev-form-disabled"));
          for (const [, , text] of notices) assert.equal(text, notice);
        }
      }
      assert.equal(read("404.html").includes('<meta name="robots" content="noindex, nofollow">'), expected);
    });
  });
}

test("dev builds with all endpoints empty and disables every form", () => {
  const emptyEndpoints = Object.fromEntries(Object.keys(intake).map((name) => [name, ""]));
  withBuild({ DEPLOY_ENV: "dev", NEXT_PUBLIC_SUPABASE_URL: "", ...emptyEndpoints }, (result, read) => {
    assert.equal(result.status, 0, result.stderr);
    for (const prefix of ["", "ar/"]) {
      for (const route of ["", "track/", "drivers/", "drivers/apply/", "drivers/status/"]) {
        const html = read(`${prefix}${route}index.html`);
        const forms = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)];
        assert.equal(forms.length, 4);
        for (const [, contents] of forms) {
          assert.match(contents, /^<fieldset class="dev-form-disabled" disabled>[\s\S]*<\/fieldset>$/);
        }
      }
    }
  });
});

for (const [name, url] of Object.entries(intake)) {
  test(`dev rejects a different origin for ${name} without logging it`, () => {
    withBuild({ DEPLOY_ENV: "dev", [name]: url.replace(devUrl, otherUrl) }, (result) => {
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(`${name} must use the NEXT_PUBLIC_SUPABASE_URL origin`));
      assert.ok(!result.stderr.includes("example.invalid"));
    });
  });
}

test("dev rejects missing authority and relative or malformed intake URLs", () => {
  for (const env of [
    { NEXT_PUBLIC_SUPABASE_URL: "" },
    { LANDING_CONTACT_ENDPOINT: "/marketing-lead-intake" },
    { LANDING_CONTACT_ENDPOINT: "//other.example.invalid/marketing-lead-intake" },
    { LANDING_CONTACT_ENDPOINT: "https://[" },
    { LANDING_DRIVER_APPLICATION_STATUS_ENDPOINT: "", LANDING_DRIVER_STATUS_ENDPOINT: `${otherUrl}/status` },
  ]) {
    withBuild({ DEPLOY_ENV: "dev", ...env }, (result) => {
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes("NEXT_PUBLIC_SUPABASE_URL"));
      assert.ok(!result.stderr.includes("example.invalid"));
    });
  }
});

const pagesEnv = {
  DEPLOY_ENV: "dev",
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef".repeat(2),
  CLOUDFLARE_PAGES_PROJECT_LANDING: "example-preview",
  CLOUDFLARE_API_TOKEN: "synthetic-token",
};

function deployment(day, fields = {}) {
  return {
    id: `abcdef${String(day).padStart(2, "0")}-1234-1234-1234-123456789abc`,
    created_on: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`,
    aliases: [],
    environment: "preview",
    ...fields,
  };
}

const created = deployment(3, { latest_stage: { name: "deploy", status: "success" } });
const receipt = {
  deployment_id: created.id,
  environment: "preview",
  pages_project: pagesEnv.CLOUDFLARE_PAGES_PROJECT_LANDING,
};

test("pruning keeps the three newest, the new deployment and current alias targets", async () => {
  const older = deployment(1);
  const old = deployment(2);
  const currentAlias = deployment(4, { aliases: ["https://dev.preview.example.invalid"] });
  const prod = deployment(8, { environment: "production" });
  const pages = [[deployment(5), currentAlias, created, deployment(6)], [older, deployment(7), old, prod]];
  const deleted = [];
  const messages = [];
  const log = { log: (line) => messages.push(line), warn: assert.fail };

  await prunePreviewDeployments(pagesEnv, receipt, async (url, options) => {
    const parsed = new URL(url);
    if (options.method === "GET") {
      assert.equal(parsed.searchParams.get("env"), "preview");
      const page = Number(parsed.searchParams.get("page"));
      return { ok: true, json: async () => ({ success: true, result: pages[page - 1], result_info: { total_pages: 2 } }) };
    }
    assert.equal(options.method, "DELETE");
    assert.equal(parsed.searchParams.get("force"), "false");
    deleted.push(parsed.pathname.split("/").at(-1));
    return { ok: true, json: async () => ({ success: true }) };
  }, log);

  assert.deepEqual(deleted, [old.id, older.id]);
  assert.deepEqual(messages, [
    `Deleted landing preview ${old.id.slice(0, 8)}`,
    `Deleted landing preview ${older.id.slice(0, 8)}`,
    "Landing previews listed: 7, kept: 5, deleted: 2",
  ]);
});

test("pruning makes no deletions if a later list page fails", async () => {
  const requests = [];
  const warnings = [];
  const log = { log: assert.fail, warn: (line) => warnings.push(line) };
  await prunePreviewDeployments(pagesEnv, receipt, async (url, { method }) => {
    requests.push(method);
    if (new URL(url).searchParams.get("page") === "2") throw new Error("synthetic list error");
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: [created, deployment(4), deployment(5), deployment(6), deployment(1)],
        result_info: { total_pages: 2 },
      }),
    };
  }, log);
  assert.deepEqual(requests, ["GET", "GET"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /pruning skipped/);
});

test("a failed preview deletion warns and the prune command exits successfully", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-prune-test-"));
  try {
    const receiptPath = path.join(dir, "deploy.ndjson");
    const mockPath = path.join(dir, "mock-fetch.cjs");
    fs.writeFileSync(receiptPath, JSON.stringify({ type: "pages-deploy-detailed", version: 1, ...receipt }));
    const previews = [created, deployment(4), deployment(5), deployment(1)];
    fs.writeFileSync(mockPath, `
      globalThis.fetch = async (_, { method }) => {
        if (method === "DELETE") return { ok: false, status: 409 };
        return { ok: true, json: async () => ({ success: true, result: ${JSON.stringify(previews)} }) };
      };
    `);
    const result = spawnSync(process.execPath, [
      "--require", mockPath, "scripts/frontend/prune-landing-previews.js", receiptPath,
    ], { cwd: repo, env: { ...process.env, ...pagesEnv }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "Landing previews listed: 4, kept: 4, deleted: 0");
    assert.equal(result.stderr.trim(), "::warning::Landing preview deletions incomplete: 1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pruning stays off outside dev and without a successful preview", async () => {
  await prunePreviewDeployments({ ...pagesEnv, DEPLOY_ENV: "stg" }, receipt, assert.fail, { log: assert.fail, warn: assert.fail });
  const requests = [];
  const warnings = [];
  await prunePreviewDeployments(pagesEnv, receipt, async (url, { method }) => {
    requests.push(method);
    return { ok: true, json: async () => ({ success: true, result: [deployment(3)] }) };
  }, { log: assert.fail, warn: (line) => warnings.push(line) });
  assert.deepEqual(requests, ["GET"]);
  assert.equal(warnings.length, 1);
});
