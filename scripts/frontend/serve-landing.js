#!/usr/bin/env node
/* eslint-disable no-console */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { parseFlagArgs } = require("../utils/cli-args");
const { loadEnv } = require("../utils/load-env");
const { isLocalSiteUrl } = require("../ops/ci/release-verify-preview");

loadEnv();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function stripMountPrefix(urlPath, basePath = "/") {
  return urlPath.startsWith(basePath) ? urlPath.slice(basePath.length - 1) : null;
}

function safeJoin(rootDir, urlPath) {
  const clean = urlPath.split("?")[0].split("#")[0];
  const decoded = decodeURIComponent(clean);
  const joined = path.join(rootDir, decoded);
  const resolved = path.resolve(joined);
  const resolvedRoot = path.resolve(rootDir);
  if (!resolved.startsWith(resolvedRoot)) return null;
  return resolved;
}

function resolveRouteRewrite(rootDir, urlPath) {
  const clean = String(urlPath || "").split("?")[0].split("#")[0];
  const rewrites = [
    {
      pattern: /^\/drivers\/status\/[^/]+\/?$/i,
      target: "/drivers/status/index.html",
    },
    {
      pattern: /^\/ar\/drivers\/status\/[^/]+\/?$/i,
      target: "/ar/drivers/status/index.html",
    },
  ];

  const match = rewrites.find((entry) => entry.pattern.test(clean));
  if (!match) return null;
  return safeJoin(rootDir, match.target);
}

function build(outDir) {
  const res = spawnSync(process.execPath, [path.join("scripts", "frontend", "build-landing.js"), "--out", outDir], {
    stdio: "inherit",
    env: process.env,
  });
  const code = typeof res.status === "number" ? res.status : 1;
  if (code !== 0) process.exit(code);
}

async function handleLocalIntakeMock(req, res, { enabled = false, siteUrl = "" } = {}) {
  if (!enabled) return false;
  const pathname = new URL(req.url || "/", "http://localhost").pathname.replace(/\/+$/g, "");
  if (!["/__landing-contact", "/__tenant-signup"].includes(pathname)) return false;
  const reply = (status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const reject = (status, code) => reply(status, { ok: false, mock: true, error: { code } });
  if (!isLocalSiteUrl(siteUrl) || !isLocalSiteUrl(`http://${req.headers.host || ""}`)) {
    reject(403, "local_mock_only");
  } else if (req.method !== "POST") {
    reject(405, "method_not_allowed");
  } else if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    reject(415, "unsupported_content_type");
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size <= 64 * 1024) chunks.push(Buffer.from(chunk));
    }
    if (size > 64 * 1024) {
      reject(413, "body_too_large");
      return true;
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* rejected below */ }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      reject(400, "invalid_json");
    } else {
      const tenant = pathname === "/__tenant-signup";
      const id = tenant ? "00000000-0000-4000-8000-000000000002" : "00000000-0000-4000-8000-000000000001";
      reply(200, { ok: true, mock: true, status: "under_review", ...(tenant ? { request_id: id } : { id }) });
    }
  }
  return true;
}

function main() {
  const args = parseFlagArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const port = Number.parseInt(process.env.LANDING_PORT || String(args.port || "3333"), 10);
  const intakeMocks = isTruthy(process.env.LANDING_ENABLE_INTAKE_MOCKS);
  const host = String(process.env.LANDING_HOST || "").trim() || (intakeMocks ? "127.0.0.1" : "");
  if (intakeMocks && !["localhost", "127.0.0.1", "::1"].includes(host.toLowerCase())) {
    throw new Error("LANDING_ENABLE_INTAKE_MOCKS requires LANDING_HOST to be localhost, 127.0.0.1 or ::1.");
  }
  const outDir = path.resolve(repoRoot, String(args.out || "dist/landing"));
  const basePath = `${String(args["base-path"] || "/").replace(/\/+$/g, "")}/`;

  if (!process.env.LANDING_SITE_URL && host) process.env.LANDING_SITE_URL = `http://${host === "::1" ? "[::1]" : host}:${port}`;
  if (intakeMocks && !isLocalSiteUrl(process.env.LANDING_SITE_URL)) {
    throw new Error("LANDING_ENABLE_INTAKE_MOCKS requires a local LANDING_SITE_URL.");
  }

  const skipBuild = isTruthy(args["skip-build"]) || isTruthy(process.env.LANDING_SKIP_BUILD);
  if (!skipBuild) build(outDir);

  const server = http.createServer(async (req, res) => {
    try {
      if (await handleLocalIntakeMock(req, res, { enabled: intakeMocks, siteUrl: process.env.LANDING_SITE_URL })) return;
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        res.end("Method not allowed");
        return;
      }

      const urlPath = stripMountPrefix(String(req.url || "/"), basePath);
      if (urlPath === null) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const target = safeJoin(outDir, urlPath === "/" ? "/index.html" : urlPath);
      if (!target) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("Bad request");
        return;
      }

      let filePath = target;
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }

      // Support clean /ar/ style routes.
      if (!fs.existsSync(filePath) && !path.extname(filePath)) {
        const maybeIndex = path.join(filePath, "index.html");
        if (fs.existsSync(maybeIndex)) filePath = maybeIndex;
      }

      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        const rewrittenTarget = resolveRouteRewrite(outDir, urlPath);
        if (rewrittenTarget && fs.existsSync(rewrittenTarget) && fs.statSync(rewrittenTarget).isFile()) {
          filePath = rewrittenTarget;
        }
      }

      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      res.writeHead(200, { "content-type": contentType(filePath) });
      if (method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Server error";
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(message);
    }
  });

  server.on("error", (err) => {
    const code = err && typeof err === "object" ? err.code : null;
    if (code === "EADDRINUSE") {
      console.error(`[landing] Failed to bind. Port ${port} is already in use.`);
      console.error(
        "[landing] Stop the process using the port or set LANDING_PORT (or LANDING_E2E_PORT for Playwright) to a free port."
      );
      process.exit(1);
    }

    const message = err instanceof Error ? err.message : String(err || "Server error");
    console.error(`[landing] Server error: ${message}`);
    process.exit(1);
  });

  server.listen(port, host || undefined, () => {
    const locationHint = host ? `http://${host}:${port}` : `http://<set LANDING_HOST>:${port}`;
    console.log(`[landing] Serving ${path.relative(repoRoot, outDir)} at ${locationHint}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  handleLocalIntakeMock,
  isTruthy,
  main,
  stripMountPrefix,
};
