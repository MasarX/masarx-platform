const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { chromium } = require("playwright");

const repoRoot = path.resolve(__dirname, "..", "..");

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--app=")) out.app = arg.split("=")[1];
    else if (arg === "--app") out.app = args[i + 1];
    else if (arg.startsWith("--out=")) out.outDir = arg.split("=")[1];
    else if (arg === "--out") out.outDir = args[i + 1];
    else if (arg.startsWith("--limit=")) out.limit = arg.split("=")[1];
    else if (arg === "--limit") out.limit = args[i + 1];
    else if (arg.startsWith("--email=")) out.email = arg.split("=")[1];
    else if (arg === "--email") out.email = args[i + 1];
    else if (arg.startsWith("--password=")) out.password = arg.split("=")[1];
    else if (arg === "--password") out.password = args[i + 1];
    else if (arg.startsWith("--landing-base-url="))
      out.landingBaseUrl = arg.split("=")[1];
    else if (arg === "--landing-base-url") out.landingBaseUrl = args[i + 1];
    else if (arg === "--headed") out.headed = true;
    else if (arg === "--no-start") out.startServers = false;
  }
  return out;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFileSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function defaultTargets() {
  const landingBaseUrl = process.env.LANDING_SITE_URL || process.env.LANDING_APP_URL;
  return {
    console: { baseURL: "http://localhost:3001", basePath: "/" }, // objectives:allow LOCALHOST Justification: Local UI audit capture defaults; override via args/env for hosted runs.
    portal: { baseURL: "http://localhost:3002", basePath: "/" }, // objectives:allow LOCALHOST Justification: Local UI audit capture defaults; override via args/env for hosted runs.
    landing: {
      baseURL: landingBaseUrl || "http://localhost:3333",
      basePath: "/",
      isLanding: true,
    },
  };
}

function normalizeUrl(baseURL, href) {
  try {
    return new URL(href, baseURL).toString();
  } catch {
    return null;
  }
}

function joinAppPath(basePath, href) {
  const normalizedBase = String(basePath || "").trim() || "/";
  const normalizedHref = String(href || "").trim();
  if (!normalizedHref) return normalizedBase;
  if (!normalizedHref.startsWith("/")) return normalizedHref;
  if (normalizedBase === "/" || normalizedBase === "") return normalizedHref;
  const base = normalizedBase.replace(/\/+$/g, "");
  return `${base}${normalizedHref}`;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function isLikelyAppLink(href, basePath) {
  if (!href) return false;
  if (href.startsWith("http://") || href.startsWith("https://")) return false;
  if (!href.startsWith("/")) return false;
  if (href.startsWith("/_next")) return false;
  if (href.includes("#")) return false;
  const normalizedBase = basePath === "/" ? "" : basePath.replace(/\/+$/g, "");
  return href === normalizedBase || href.startsWith(`${normalizedBase}/`);
}

async function maybeSignInWithPassword(page, email, password) {
  if (!email || !password) return { signedIn: false };
  const form = page.locator('form:has(button:has-text("Sign in"))').first();
  if ((await form.count()) === 0) return { signedIn: false };

  const passwordRadio = form.locator('input[type="radio"][value="password"]');
  if ((await passwordRadio.count()) > 0) {
    await passwordRadio.check().catch(() => null);
  } else {
    await form
      .getByRole("radio", { name: /password/i })
      .check()
      .catch(() => null);
    await form.getByText(/^password$/i).first().click().catch(() => null);
  }

  const emailInput = form.locator('input[name="email"]');
  const passwordInput = form.locator('input[name="password"]');
  if ((await emailInput.count()) === 0) {
    return { signedIn: false };
  }
  if ((await passwordInput.count()) === 0) {
    await passwordInput
      .waitFor({ state: "visible", timeout: 5_000 })
      .catch(() => null);
  }
  if ((await passwordInput.count()) === 0) {
    return { signedIn: false };
  }
  await emailInput.fill(email);
  await passwordInput.fill(password);
  const authResponse = page
    .waitForResponse(
      (response) =>
        response.url().includes("/auth/v1/token") &&
        response.request().method() === "POST",
      { timeout: 20_000 }
    )
    .catch(() => null);
  await form.getByRole("button", { name: /^sign in$/i }).click();
  const response = await authResponse;
  if (response && response.status() >= 400) {
    return { signedIn: false };
  }
  await page
    .getByText(/signed in:?/i)
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => null);
  return { signedIn: true };
}

function buildPageStateSelector(prefix) {
  const suffixes = [
    "ready",
    "error",
    "auth-required",
    "blocked",
    "not-found",
    "empty",
    "missing-env",
    "loading",
  ];
  return suffixes
    .map((suffix) => `[data-testid^="${prefix}-"][data-testid$="-${suffix}"]`)
    .join(", ");
}

function normalizeAppNameStateCandidate(appName, value) {
  if (!value) return "";
  const normalized = String(value).trim();
  if (!normalized) return "";
  if (normalized.startsWith(`${appName}-`)) return normalized;
  return `${appName}-${normalized}`;
}

async function inferFallbackPageState(page, appName) {
  const fallback = page.locator(`[data-testid^="${appName}-"]`).first();
  if ((await fallback.count()) > 0) {
    const value = await fallback.getAttribute("data-testid");
    if (value) return value;
  }

  const notFound = [
    /404/i,
    /not found/i,
    /page not found/i,
    /does not exist/i,
  ];
  for (const pattern of notFound) {
    if ((await page.getByText(pattern).count()) > 0) {
      return `${appName}-not-found`;
    }
  }

  const authState = [
    /sign in/i,
    /authentication required/i,
    /access denied/i,
  ];
  for (const pattern of authState) {
    if ((await page.getByText(pattern).count()) > 0) {
      return `${appName}-auth-required`;
    }
  }

  const errorState = [/error/i, /failed/i, /something went wrong/i, /unavailable/i];
  for (const pattern of errorState) {
    if ((await page.getByText(pattern).count()) > 0) {
      return `${appName}-error`;
    }
  }

  return `${appName}-unknown`;
}

async function waitForPageState(page, appName, timeoutMs = 60_000) {
  const selector = buildPageStateSelector(appName);
  const state = page.locator(selector).first();
  try {
    await state.waitFor({ state: "visible", timeout: timeoutMs });
    return normalizeAppNameStateCandidate(
      appName,
      await state.getAttribute("data-testid")
    );
  } catch {
    return await inferFallbackPageState(page, appName);
  }
}

async function waitForLandingReady(page, basePath) {
  const anchors = page.locator("main");
  await page.waitForLoadState("networkidle", { timeout: 60_000 });
  if (await anchors.count() > 0) {
    await anchors.first().waitFor({ state: "visible", timeout: 30_000 });
  }
  await page
    .locator(basePath === "/" ? "#main" : `${basePath}#main`)
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => null);
  await page.waitForTimeout(500);
  return `${basePath === "/" ? "landing" : `landing-${basePath.replace(/\//g, "")}`}-ready`;
}

async function captureScreenshot(page, outDir, name) {
  const fileName = `${sanitizeFileSegment(name)}.png`;
  const filePath = path.join(outDir, fileName);
  await page.screenshot({ path: filePath, fullPage: true, animations: "disabled" });
  return filePath;
}

async function collectSidebarLinks(page, basePath) {
  const candidates = await page.$$eval("nav a[href]", (anchors) =>
    anchors
      .map((anchor) => anchor.getAttribute("href"))
      .filter(Boolean)
  );
  const filtered = uniqueStrings(candidates).filter((href) =>
    isLikelyAppLink(href, basePath)
  );
  return filtered;
}

async function collectLandingAnchors(page, basePath) {
  const anchors = await page.$$eval("a[href]", (elements) =>
    elements
      .map((element) => element.getAttribute("href"))
      .filter(Boolean)
  );
  const normalized = uniqueStrings(anchors).filter((href) => {
    if (href.startsWith("http://") || href.startsWith("https://")) return false;
    if (href.startsWith("#")) return true;
    if (href === "/" || href.startsWith("/")) return true;
    return false;
  });
  return uniqueStrings(
    normalized.map((href) =>
      href.startsWith(basePath) || href === "/" ? href : `${basePath}${href}`
    )
  ).filter((href) => href !== "javascript:void(0)");
}

async function waitForNavigationHydrated(page) {
  const pending = page.getByText("Navigation pending");
  try {
    await pending.waitFor({ state: "detached", timeout: 30_000 });
    return true;
  } catch {
    try {
      await pending.waitFor({ state: "hidden", timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}

async function captureApp({ appName, target, browser, outDir, limit, auth }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push({ text: message.text(), location: message.location() });
    }
  });

  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push({ message: error.message, stack: error.stack });
  });

  const report = {
    app: appName,
    baseURL: target.baseURL,
    basePath: target.basePath,
    auth: auth.email ? { email: auth.email } : null,
    pages: [],
    consoleErrors,
    pageErrors,
  };

  const baseUrlWithPath = `${target.baseURL}${target.basePath}`;
  await page.goto(baseUrlWithPath, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const signedAttempt = await maybeSignInWithPassword(page, auth.email, auth.password);
  let dashboardState = target.isLanding
    ? await waitForLandingReady(page, target.basePath)
    : await waitForPageState(page, appName);
  if (
    !target.isLanding &&
    !signedAttempt.signedIn &&
    dashboardState.endsWith("auth-required") &&
    auth.email &&
    auth.password
  ) {
    await maybeSignInWithPassword(page, auth.email, auth.password);
    dashboardState = await waitForPageState(page, appName);
  }
  const navReady = !target.isLanding && signedAttempt.signedIn
    ? await waitForNavigationHydrated(page)
    : false;

  report.pages.push({
    url: baseUrlWithPath,
    state: dashboardState,
    navReady,
    screenshot: await captureScreenshot(page, outDir, `${appName}-dashboard`),
  });

  const links = target.isLanding
    ? await collectLandingAnchors(page, target.basePath)
    : await collectSidebarLinks(page, target.basePath);
  const extraRoutes = [
    joinAppPath(target.basePath, "/commands"),
    joinAppPath(target.basePath, "/resources/shipments"),
    ...(target.isLanding
      ? ["/", "/ar/", "/__frontend-ux-missing"]
      : [
          joinAppPath(target.basePath, "/__frontend-ux-not-found"),
          ...(appName === "console"
            ? [
                joinAppPath(target.basePath, "/workflows/queue"),
                joinAppPath(target.basePath, "/workflows/requests"),
              ]
            : [joinAppPath(target.basePath, "/workflows/queue")]),
        ]),
  ];
  const hrefs = uniqueStrings([...extraRoutes, ...links]).slice(0, limit);

  for (const href of hrefs) {
    const url = target.isLanding ? normalizeUrl(target.baseURL, href) : normalizeUrl(target.baseURL, href);
    if (!url) continue;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
    const state = target.isLanding
      ? await waitForLandingReady(page, target.basePath)
      : await waitForPageState(page, appName);
    report.pages.push({
      url,
      state,
      screenshot: await captureScreenshot(page, outDir, `${appName}-${href}`),
    });
  }

  await context.close();
  return report;
}

async function waitForUrl(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) return true;
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function spawnDevServer(command) {
  const child = spawn(command, {
    cwd: repoRoot,
    shell: true,
    stdio: "inherit",
    env: { ...process.env },
  });
  child.on("exit", (code, signal) => {
    if (code === 0) return;
    if (signal) return;
    console.warn(`[ui-ux-audit] dev server exited with code ${code}`);
  });
  return child;
}

function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      shell: true,
    });
  } catch {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
}

async function ensureServerRunning(appName, target, shouldStart) {
  const url = `${target.baseURL}${target.basePath}`;
  const reachable = await waitForUrl(url, 5000);
  if (reachable) return { url, child: null };
  if (!shouldStart) {
    throw new Error(
      `Dev server for ${appName} not reachable at ${url}. Start it (npm run dev:${appName}) or omit --no-start.`
    );
  }

  const command = `npm run dev:${appName}`;
  const child = spawnDevServer(command);
  const ok = await waitForUrl(url, 180_000);
  if (!ok) {
    killProcessTree(child);
    throw new Error(`Timed out waiting for ${appName} dev server at ${url}.`);
  }
  return { url, child };
}

async function main() {
  const args = parseArgs(process.argv);
  const targets = defaultTargets();
  if (args.landingBaseUrl) {
    targets.landing.baseURL = args.landingBaseUrl;
  }
  const appArg = (args.app || "both").toLowerCase();
  const apps =
    appArg === "both"
      ? ["console", "portal", "landing"]
      : appArg === "console" || appArg === "portal" || appArg === "landing"
        ? [appArg]
        : [];

  if (apps.length === 0) {
    throw new Error('Invalid --app. Use "console", "portal", "landing", or "both".');
  }

  const limitRaw = Number.parseInt(args.limit ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 12;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args.outDir
    ? path.resolve(repoRoot, args.outDir)
    : path.join(repoRoot, "test-results", "ui-ux-audit", timestamp);

  ensureDir(outDir);

  const shouldStart = args.startServers !== false;
  const started = [];
  for (const appName of apps) {
    // eslint-disable-next-line no-await-in-loop
    const result = await ensureServerRunning(appName, targets[appName], shouldStart);
    if (result.child) started.push(result.child);
  }

  const browser = await chromium.launch({ headless: !args.headed });
  try {
    const reports = [];
    for (const appName of apps) {
      const auth = {
        email:
          args.email || String(process.env.SCREENSHOT_AUTH_EMAIL || process.env.DEV_SIGNIN_EMAIL || "").trim(),
        password: String(
          args.password || process.env.SCREENSHOT_SIGNIN_PASSWORD || process.env.DEV_SIGNIN_PASSWORD || ""
        ).trim(),
      };
      const report = await captureApp({
        appName,
        target: targets[appName],
        browser,
        outDir,
        limit,
        auth,
      });
      reports.push(report);
    }

    const reportPath = path.join(outDir, "report.json");
    fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: timestamp, reports }, null, 2));
    console.log(`UI/UX audit captures written to ${outDir}`);
    console.log(`Report: ${reportPath}`);
  } finally {
    await browser.close();
    started.forEach((child) => killProcessTree(child));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
