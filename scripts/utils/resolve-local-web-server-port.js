const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const LOCAL_WEB_SERVER_PORT_FALLBACK_SCAN_LIMIT = 128;

function parsePort(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sanitizeCacheSegment(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

function resolveLocalWebServerPortCachePath(options = {}) {
  const explicitCachePath = String(
    options.cachePath ?? process.env.LANDING_E2E_PORT_CACHE_FILE ?? "",
  ).trim();
  if (explicitCachePath) {
    return explicitCachePath;
  }

  const runId = sanitizeCacheSegment(options.runId ?? process.env.GITHUB_RUN_ID);
  if (!runId || runId === "unknown") {
    return null;
  }

  const preferredPort = parsePort(options.preferredPort);
  if (!preferredPort) {
    return null;
  }

  const cacheBaseDir =
    String(options.cacheDir ?? process.env.RUNNER_TEMP ?? os.tmpdir()).trim() || os.tmpdir();
  const cacheScope = [
    options.workflow ?? process.env.GITHUB_WORKFLOW,
    options.job ?? process.env.GITHUB_JOB,
    runId,
    sanitizeCacheSegment(options.runAttempt ?? process.env.GITHUB_RUN_ATTEMPT ?? "1"),
    sanitizeCacheSegment(options.sha ?? process.env.GITHUB_SHA),
  ]
    .filter((segment) => segment && segment !== "unknown")
    .map(sanitizeCacheSegment)
    .join("-");

  return path.join(
    cacheBaseDir,
    `landing-web-server-port-${preferredPort}-${cacheScope || runId}.txt`,
  );
}

function readCachedPort(cachePath) {
  if (!cachePath) {
    return null;
  }

  try {
    return parsePort(fs.readFileSync(cachePath, "utf8"));
  } catch {
    return null;
  }
}

function writeCachedPort(cachePath, port) {
  if (!cachePath) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${port}\n`, "utf8");
  } catch {
    // Ignore cache write failures; the resolver still returns the chosen port.
  }
}

function resolveLocalWebServerPort(options = {}) {
  const preferredPort = parsePort(options.preferredPort);
  if (!preferredPort) {
    throw new Error("resolveLocalWebServerPort requires a positive preferredPort");
  }

  const cachePath = resolveLocalWebServerPortCachePath({ ...options, preferredPort });
  const allowOccupiedCachedPort = Boolean(options.allowOccupiedCachedPort);

  // objectives:allow LOCALHOST Justification: Landing Playwright reserves a port on the same loopback interface the local static server binds to.
  const host = String(options.host || "127.0.0.1").trim() || "127.0.0.1";
  const resolverScript = [
    // objectives:allow LOCALHOST Justification: The child-process probe must test the same loopback interface the landing dev server later binds to.
    "const net = require('node:net');",
    "const host = process.argv[1] || '127.0.0.1';",
    "const port = Number.parseInt(process.argv[2] || '', 10);",
    "function listenOnce(port) {",
    "  return new Promise((resolve) => {",
    "    const server = net.createServer();",
    "    server.unref();",
    "    server.on('error', () => resolve(null));",
    "    server.listen({ host, port }, () => {",
    "      const address = server.address();",
    "      const resolvedPort = address && typeof address === 'object' ? address.port : null;",
    "      server.close(() => resolve(resolvedPort));",
    "    });",
    "  });",
    "}",
    "(async () => {",
    "  const resolved = Number.isFinite(port) && port > 0 ? await listenOnce(port) : null;",
    "  if (!resolved) process.exit(1);",
    "  process.stdout.write(String(resolved));",
    "})().catch(() => process.exit(1));",
  ].join("\n");

  const probePort = (port) => {
    const result = spawnSync(process.execPath, ["-e", resolverScript, host, String(port)], {
      encoding: "utf8",
      windowsHide: true,
    });

    if (result.status === 0) {
      const resolvedPort = parsePort(result.stdout);
      if (resolvedPort) {
        return resolvedPort;
      }
    }

    return null;
  };

  const cachedPort = readCachedPort(cachePath);
  if (cachedPort) {
    const cachedResolved = probePort(cachedPort);
    if (cachedResolved) {
      writeCachedPort(cachePath, cachedResolved);
      return cachedResolved;
    }
    if (allowOccupiedCachedPort) {
      return cachedPort;
    }
  }

  const preferredResolved = probePort(preferredPort);
  if (preferredResolved) {
    writeCachedPort(cachePath, preferredResolved);
    return preferredResolved;
  }

  for (let offset = 1; offset <= LOCAL_WEB_SERVER_PORT_FALLBACK_SCAN_LIMIT; offset += 1) {
    const candidatePort = preferredPort + offset;
    const resolvedPort = probePort(candidatePort);
    if (resolvedPort) {
      writeCachedPort(cachePath, resolvedPort);
      return resolvedPort;
    }
  }

  return preferredPort;
}

module.exports = {
  LOCAL_WEB_SERVER_PORT_FALLBACK_SCAN_LIMIT,
  parsePort,
  resolveLocalWebServerPortCachePath,
  resolveLocalWebServerPort,
};
