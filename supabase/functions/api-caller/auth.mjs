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

const { decodeJwtPayload, extractToken, validateInternalEdgeClaims } = await loadShared();

const ROLE_OPERATIONS = Object.freeze({
  edge_api_caller_role: Object.freeze(["job", "batch"]),
  edge_api_gateway_role: Object.freeze(["job"]),
  edge_webhook_role: Object.freeze(["job"]),
  service_role: Object.freeze(["job", "batch"]),
});

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

const normalizeVerifiedClaims = (value) => {
  if (!value || typeof value !== "object") return null;
  if (value.claims && typeof value.claims === "object") return value.claims;
  return value;
};

export const authorizeEdgeRequest = async (req, options = {}) => {
  const allowedRoles = parseAllowedRoles();
  if (!allowedRoles.length) {
    return { ok: false, status: 500, message: "Server missing EDGE_INTERNAL_CALLER_ROLES" };
  }

  const provided = extractAuthToken(req);
  if (!provided) {
    return { ok: false, status: 401, message: "Missing Authorization token" };
  }

  // Supabase's native verify_jwt gate validates the signature before this
  // handler runs. Decoding here is only for narrower claim-policy checks.
  const claims = normalizeVerifiedClaims(
    Object.prototype.hasOwnProperty.call(options, "claims")
      ? options.claims
      : decodeJwtPayload(provided),
  );
  if (!claims) {
    return { ok: false, status: 401, message: "Invalid Authorization token" };
  }

  const role = String(claims.role || "").trim().toLowerCase();
  if (!role) {
    return { ok: false, status: 403, message: "Missing role claim" };
  }

  if (!allowedRoles.includes(role)) {
    return { ok: false, status: 403, message: "Unauthorized role" };
  }

  const claimPolicy = validateInternalEdgeClaims(claims, role, options);
  if (!claimPolicy.ok) return claimPolicy;

  const allowedOperations = ROLE_OPERATIONS[role] || [];
  if (!allowedOperations.length) {
    return { ok: false, status: 403, message: "Role is not authorized for api-caller" };
  }

  return { ok: true, role, claims, allowedOperations };
};

export const authorizeApiCallerOperation = (authorization, operation) => {
  if (!authorization?.ok) {
    return { ok: false, status: 401, message: "Unauthorized request" };
  }

  const normalized = String(operation || "").trim().toLowerCase();
  if (!authorization.allowedOperations?.includes(normalized)) {
    return { ok: false, status: 403, message: `Caller role cannot execute ${normalized || "unknown"} operations` };
  }

  return { ok: true };
};
