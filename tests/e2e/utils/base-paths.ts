import { isStrictE2EEnv } from "./env";

const DEFAULT_ORIGINS = {
  console: "http://localhost:3001",
  portal: "http://localhost:3002",
};

const DEFAULT_BASE_PATHS = {
  console: "",
  portal: "",
};

function trimTrailingSlash(value: string) {
  return value.length > 1 ? value.replace(/\/$/, "") : value;
}

function resolveOrigin(
  urlValue: string | undefined,
  fallback: string,
  opts: { strict: boolean; envKey: string }
) {
  if (!urlValue) return fallback;
  try {
    const parsed = new URL(urlValue);
    const path = trimTrailingSlash(parsed.pathname || "");
    if (path && path !== "/") {
      if (opts.strict) {
        throw new Error(
          `${opts.envKey} must be host-root (remove path "${path}").`
        );
      }
      return fallback;
    }
    return parsed.origin;
  } catch {
    if (opts.strict) {
      throw new Error(
        `${opts.envKey} must be a valid absolute URL for strict/CI E2E.`
      );
    }
    return fallback;
  }
}

function resolveBasePath(
  urlValue: string | undefined,
  fallback: string,
  opts: { strict: boolean; envKey: string }
) {
  if (!urlValue) return fallback;
  try {
    const parsed = new URL(urlValue);
    const path = trimTrailingSlash(parsed.pathname || "");
    if (path && path !== "/") {
      if (opts.strict) {
        throw new Error(
          `${opts.envKey} must be host-root (remove path "${path}").`
        );
      }
      return fallback;
    }
    return fallback;
  } catch {
    if (opts.strict) {
      throw new Error(
        `${opts.envKey} must be a valid absolute URL for strict/CI E2E.`
      );
    }
    return fallback;
  }
}

export function getConsoleBasePath() {
  const strict = isStrictE2EEnv();
  return resolveBasePath(process.env.CONSOLE_BASE_URL, DEFAULT_BASE_PATHS.console, {
    strict,
    envKey: "CONSOLE_BASE_URL"
  });
}

export function getConsoleOrigin() {
  const strict = isStrictE2EEnv();
  return resolveOrigin(process.env.CONSOLE_BASE_URL, DEFAULT_ORIGINS.console, {
    strict,
    envKey: "CONSOLE_BASE_URL",
  });
}

export function getPortalBasePath() {
  const strict = isStrictE2EEnv();
  return resolveBasePath(process.env.PORTAL_BASE_URL, DEFAULT_BASE_PATHS.portal, {
    strict,
    envKey: "PORTAL_BASE_URL"
  });
}

export function getPortalOrigin() {
  const strict = isStrictE2EEnv();
  return resolveOrigin(process.env.PORTAL_BASE_URL, DEFAULT_ORIGINS.portal, {
    strict,
    envKey: "PORTAL_BASE_URL",
  });
}

function resolveLandingUrlValue() {
  return process.env.LANDING_BASE_URL || process.env.LANDING_SITE_URL;
}

export function getLandingBasePath() {
  return resolveBasePath(resolveLandingUrlValue(), "", {
    strict: isStrictE2EEnv(),
    envKey: "LANDING_BASE_URL",
  });
}

export function getLandingOrigin() {
  return resolveOrigin(resolveLandingUrlValue(), "http://localhost:3333", {
    strict: isStrictE2EEnv(),
    envKey: "LANDING_BASE_URL",
  });
}
