const loadShared = async () => {
  try {
    return await import("./_shared/mod.mjs");
  } catch (error) {
    // Local tests may execute before _shared is synced into function folders.
    const message = String(error?.message || "");
    const missingModule =
      error?.code === "ERR_MODULE_NOT_FOUND" ||
      message.includes("Cannot find module") ||
      message.includes("No such file") ||
      message.includes("_shared/mod.mjs");

    if (!missingModule) {
      throw error;
    }

    return import("../_shared/mod.mjs");
  }
};

const { extractToken, getJwtRole } = await loadShared();

export const extractAuthToken = (req) => {
  if (!req || typeof req.headers?.get !== "function") {
    return null;
  }

  const authorization = req.headers.get("authorization");
  if (authorization) {
    const [scheme, token] = authorization.split(" ");
    if (scheme && scheme.toLowerCase() === "bearer" && token && token.trim().length > 0) {
      return token.trim();
    }
  }

  return extractToken(req, { prefer: "authorization", allowWebhookHeader: false, allowQueryParam: false });
};

const readEnv = (key) => {
  try {
    if (typeof Deno !== "undefined" && Deno?.env?.get) {
      return Deno.env.get(key) || "";
    }
  } catch (_err) {
    // ignore
  }

  try {
    if (typeof process !== "undefined" && process?.env) {
      return process.env[key] || "";
    }
  } catch (_err) {
    // ignore
  }

  return "";
};

const parseAllowedRoles = () => {
  const raw = readEnv("EDGE_INTERNAL_CALLER_ROLES");
  return raw
    .split(",")
    .map((role) => role.trim().toLowerCase())
    .filter((role) => role.length > 0);
};

export const authorizeEdgeRequest = (req) => {
  const allowedRoles = parseAllowedRoles();
  if (!allowedRoles.length) {
    return { ok: false, status: 500, message: "Server missing EDGE_INTERNAL_CALLER_ROLES" };
  }

  const provided = extractAuthToken(req);
  if (!provided) {
    return { ok: false, status: 401, message: "Missing Authorization token" };
  }

  const role = String(getJwtRole(provided) || "").trim().toLowerCase();
  if (!role) {
    return { ok: false, status: 403, message: "Missing role claim" };
  }

  if (!allowedRoles.includes(role)) {
    return { ok: false, status: 403, message: "Unauthorized role" };
  }

  return { ok: true };
};
