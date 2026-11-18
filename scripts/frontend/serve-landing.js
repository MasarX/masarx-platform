#!/usr/bin/env node
/* eslint-disable no-console */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { parseFlagArgs } = require("../utils/cli-args");
const { loadEnv } = require("../utils/load-env");

loadEnv();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

const PREVIEW_INTAKE_ENDPOINTS = new Set([
  "/__landing-contact",
  "/__tenant-signup",
  "/__driver-signup",
]);

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
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

function jsonResponse(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-masarx-public-edge-client, x-turnstile-token",
  });
  res.end(JSON.stringify(payload));
}

function collectRequestJson(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request_body_too_large"));
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });

    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid_json"));
      }
    });

    req.on("error", reject);
  });
}

function createPreviewIntakePayload(pathname, body) {
  const now = new Date().toISOString();
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const organizationName =
    typeof body.organization_name === "string"
      ? body.organization_name.trim()
      : typeof body.company === "string"
        ? body.company.trim()
        : "";

  if (pathname === "/__tenant-signup") {
    return {
      ok: true,
      request_id: `tsr_local_${Date.now()}`,
      status: "pending",
      email,
      organization_name: organizationName,
      received_at: now,
    };
  }

  if (pathname === "/__driver-signup") {
    return {
      ok: true,
      application_id: `drv_local_${Date.now()}`,
      status: "submitted",
      status_token: `dst_local_${Date.now()}`,
      email,
      received_at: now,
    };
  }

  return {
    ok: true,
    lead_id: `lead_local_${Date.now()}`,
    status: "received",
    email,
    company: organizationName,
    received_at: now,
  };
}

async function maybeHandlePreviewIntake(req, res, urlPath) {
  const pathname = String(urlPath || "/").split("?")[0].split("#")[0].replace(/\/+$/g, "") || "/";
  if (!PREVIEW_INTAKE_ENDPOINTS.has(pathname)) return false;

  const method = String(req.method || "GET").toUpperCase();
  if (method === "OPTIONS") {
    jsonResponse(res, 204, {});
    return true;
  }

  if (method !== "POST") {
    jsonResponse(res, 405, { ok: false, error: { code: "method_not_allowed" } });
    return true;
  }

  try {
    const body = await collectRequestJson(req);
    jsonResponse(res, 200, createPreviewIntakePayload(pathname, body));
  } catch (error) {
    const code = error instanceof Error && error.message ? error.message : "invalid_request";
    jsonResponse(res, code === "request_body_too_large" ? 413 : 400, {
      ok: false,
      error: { code },
    });
  }

  return true;
}

function build(outDir) {
  const res = spawnSync(process.execPath, [path.join("scripts", "frontend", "build-landing.js"), "--out", outDir], {
    stdio: "inherit",
    env: process.env,
  });
  const code = typeof res.status === "number" ? res.status : 1;
  if (code !== 0) process.exit(code);
}

function main() {
  const args = parseFlagArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const port = Number.parseInt(process.env.LANDING_PORT || String(args.port || "3333"), 10);
  const host = String(process.env.LANDING_HOST || "").trim();
  const outDir = path.resolve(repoRoot, String(args.out || "dist/landing"));

  if (!process.env.LANDING_SITE_URL && host) process.env.LANDING_SITE_URL = `http://${host}:${port}`;

  const skipBuild = isTruthy(args["skip-build"]) || isTruthy(process.env.LANDING_SKIP_BUILD);
  if (!skipBuild) build(outDir);

  const server = http.createServer(async (req, res) => {
    try {
      const method = String(req.method || "GET").toUpperCase();
      const urlPath = String(req.url || "/");

      if (await maybeHandlePreviewIntake(req, res, urlPath)) {
        return;
      }

      if (method !== "GET" && method !== "HEAD") {
        res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        res.end("Method not allowed");
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
  createPreviewIntakePayload,
  isTruthy,
  maybeHandlePreviewIntake,
};
