import { isStrictE2EEnv } from "./env";

const DEFAULT_BASE_URLS = {
  console: "http://localhost:3001",
  portal: "http://localhost:3002",
};

function trimTrailingSlash(value: string) {
  return value.length > 1 ? value.replace(/\/$/, "") : value;
}

function resolveBaseUrl(
  urlValue: string | undefined,
  fallback: string,
  opts: { strict: boolean; envKey: string }
) {
  if (!urlValue) {
    if (opts.strict) {
      throw new Error(
        `${opts.envKey} must be set to an absolute hosted URL for strict/CI E2E (no localhost fallback).`
      );
    }
    return fallback;
  }
  try {
    const parsed = new URL(urlValue);
    if (opts.strict) {
      const host = String(parsed.hostname || "").toLowerCase();
      if (["localhost", "127.0.0.1"].includes(host) || host.endsWith(".local")) {
        throw new Error(
          `${opts.envKey} must point to a hosted URL in strict/CI E2E (got host=${host}).`
        );
      }
    }
    const path = trimTrailingSlash(parsed.pathname || "");
    if (path && path !== "/") {
      if (opts.strict) {
        throw new Error(
          `${opts.envKey} must be host-root (remove path "${path}").`
        );
      }
      return parsed.origin;
    }
    return trimTrailingSlash(parsed.origin);
  } catch {
    if (opts.strict) {
      throw new Error(
        `${opts.envKey} must be a valid absolute URL for strict/CI E2E.`
      );
    }
    return fallback;
  }
}

export function getConsoleBaseUrl() {
  const strict = isStrictE2EEnv();
  return resolveBaseUrl(process.env.CONSOLE_BASE_URL, DEFAULT_BASE_URLS.console, {
    strict,
    envKey: "CONSOLE_BASE_URL"
  });
}

export function getPortalBaseUrl() {
  const strict = isStrictE2EEnv();
  return resolveBaseUrl(process.env.PORTAL_BASE_URL, DEFAULT_BASE_URLS.portal, {
    strict,
    envKey: "PORTAL_BASE_URL"
  });
}
