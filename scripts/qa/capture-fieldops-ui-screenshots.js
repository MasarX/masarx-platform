#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const http = require("http");
const path = require("path");
const {
  DEFAULT_CAPTURE_PLATFORMS,
  SUPPORTED_PLATFORMS,
  buildSelftestQuery,
  buildScenarioUrl,
  createFieldopsScenarioSet,
  defaultOutputDir,
  parsePlatformList,
} = require("./fieldops-ui-screenshot-scenarios");

function parseArgs(argv) {
  const out = {};
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || "");
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[index + 1];
    const value = next && !String(next).startsWith("--") ? String(next) : "1";
    if (value !== "1") index += 1;
    out[key] = value;
  }
  return out;
}

function asInt(input, fallback) {
  const parsed = Number.parseInt(String(input ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

function sendResponse(res, statusCode, body, type) {
  const payload = body == null ? "" : body;
  res.writeHead(statusCode, { "Content-Type": type || "text/plain; charset=utf-8" });
  res.end(payload);
}

function pruneStaleCaptureFiles(outputDir, expectedFiles) {
  const expected = expectedFiles instanceof Set ? expectedFiles : new Set(expectedFiles || []);
  const entries = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
  for (const name of entries) {
    if (!/^C-.*\.png$/i.test(name)) continue;
    if (expected.has(name)) continue;
    const filePath = path.join(outputDir, name);
    fs.unlinkSync(filePath);
    console.log(`[fieldops-screenshots] removed stale ${name}`);
  }
}

function createStaticServer({ rootDir, host, port }) {
  const normalizedRoot = path.normalize(rootDir);
  const server = http.createServer((req, res) => {
    try {
      const base = `http://${host}:${port}`;
      const url = new URL(req.url || "/", base);
      const relativePath = url.pathname === "/" ? "version-c.html" : url.pathname.replace(/^\/+/, "");
      const resolved = path.normalize(path.join(normalizedRoot, relativePath));
      if (!resolved.startsWith(normalizedRoot)) {
        sendResponse(res, 403, "forbidden");
        return;
      }
      if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
        sendResponse(res, 404, "not found");
        return;
      }
      sendResponse(res, 200, fs.readFileSync(resolved), mimeTypeFor(resolved));
    } catch (error) {
      sendResponse(res, 500, `static server error: ${error.message}`);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve(server);
    });
  });
}

async function runSelftest(page, baseUrl, platform, timeoutMs) {
  const url = buildScenarioUrl(baseUrl, buildSelftestQuery(platform));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector(".device .app", { timeout: timeoutMs });
  await page.waitForSelector(
    ".selftest-banner[data-status='pass'], .selftest-banner[data-status='fail']",
    { timeout: timeoutMs },
  );
  const summary = await page.evaluate(() => {
    const state = window.__FIELD_OPS_SELFTEST__;
    const root = document.querySelector(".selftest-banner");
    const status = state?.status || root?.getAttribute("data-status") || "unknown";
    const items = Array.isArray(state?.steps)
      ? state.steps.map((text) => String(text || "").trim()).filter(Boolean)
      : Array.from(document.querySelectorAll(".selftest-banner .muted"))
          .map((node) => node.textContent || "")
          .map((text) => text.trim())
          .filter(Boolean);
    const error =
      status === "fail"
        ? state?.error || items.find((text) => /^FAIL\b/i.test(text) || /\berror\b/i.test(text)) || null
        : null;
    return { status, steps: items, error };
  });
  if (summary.status !== "pass") {
    throw new Error(
      `FieldOps sample selftest failed for platform=${platform} (status=${summary.status}${summary.error ? `, error=${summary.error}` : ""})`,
    );
  }
  return { platform, url, ...summary };
}

async function captureScenarios({
  page,
  baseUrl,
  scenarios,
  outputDir,
  renderWaitMs,
  timeoutMs,
}) {
  const manifest = [];
  for (const scenario of scenarios) {
    const scenarioUrl = buildScenarioUrl(baseUrl, scenario.query);
    const fileName = `${scenario.name}.png`;
    const outputPath = path.join(outputDir, fileName);
    await page.goto(scenarioUrl, { waitUntil: "networkidle" });
    await page.waitForSelector(".device .app", { timeout: timeoutMs });
    if (renderWaitMs > 0) {
      await page.waitForTimeout(renderWaitMs);
    }
    await page.screenshot({ path: outputPath, fullPage: true });
    manifest.push({
      name: scenario.name,
      file: fileName,
      url: scenarioUrl,
    });
    console.log(`[fieldops-screenshots] captured ${fileName}`);
  }
  return manifest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = path.resolve(
    String(args["source-dir"] || "docs/product/examples/mobile-field-ops-ui"),
  );
  const outputDir = path.resolve(String(args["output-dir"] || defaultOutputDir()));
  const host = String(args.host || process.env.FIELDOPS_UI_CAPTURE_HOST || "127.0.0.1"); // objectives:allow LOCALHOST Justification: local-only static screenshot harness bound to loopback for deterministic capture.
  const port = asInt(args.port, 4179);
  const timeoutMs = asInt(args["timeout-ms"], 30_000);
  const renderWaitMs = asInt(args["render-wait-ms"], 200);
  const requestedPlatforms =
    args.platforms || process.env.FIELDOPS_UI_CAPTURE_PLATFORMS || DEFAULT_CAPTURE_PLATFORMS.join(",");
  const platforms = parsePlatformList(requestedPlatforms);

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`FieldOps sample source directory not found: ${sourceDir}`);
  }
  if (!platforms.length) {
    throw new Error(
      `No valid platforms were provided. Supported: ${SUPPORTED_PLATFORMS.join(", ")}`
    );
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const baseUrl = `http://${host}:${port}`;
  console.log(`[fieldops-screenshots] source=${sourceDir}`);
  console.log(`[fieldops-screenshots] output=${outputDir}`);
  console.log(`[fieldops-screenshots] serving ${baseUrl}`);
  console.log(`[fieldops-screenshots] platforms=${platforms.join(",")}`);

  const server = await createStaticServer({
    rootDir: sourceDir,
    host,
    port,
  });

  let browser;
  try {
    const { chromium } = require("playwright");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1024 },
      colorScheme: "light",
    });

    const selftests = [];
    const scenarios = [];
    const scenariosByPlatform = platforms.map((platform) => ({
      platform,
      scenarios: createFieldopsScenarioSet(platform),
    }));

    const expectedFiles = new Set(
      scenariosByPlatform
        .flatMap((entry) => entry.scenarios)
        .map((scenario) => `${scenario.name}.png`)
    );
    pruneStaleCaptureFiles(outputDir, expectedFiles);

    for (const { platform, scenarios: platformScenarios } of scenariosByPlatform) {
      selftests.push(await runSelftest(page, baseUrl, platform, timeoutMs));
      const nextScenarios = await captureScenarios({
        page,
        baseUrl,
        scenarios: platformScenarios,
        outputDir,
        renderWaitMs,
        timeoutMs,
      });
      scenarios.push(...nextScenarios);
    }

    const manifest = {
      captured_at: new Date().toISOString(),
      source_dir: sourceDir,
      output_dir: outputDir,
      base_url: baseUrl,
      platforms,
      selftests,
      scenarios,
    };
    const manifestPath = path.join(outputDir, "manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`[fieldops-screenshots] wrote ${manifestPath}`);
  } finally {
    if (browser) {
      await browser.close();
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[fieldops-screenshots] ${error.message}`);
    process.exit(1);
  });
}
