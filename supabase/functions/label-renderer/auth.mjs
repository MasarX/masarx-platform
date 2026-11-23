import { decodeJwtPayload, extractToken, getJwtRole, validateInternalEdgeClaims } from "./_shared/mod.mjs";

// Preserve the renderer's dispatch precedence and legacy job payload default.
export const resolveLabelRendererOperation = (payload) => {
  if (payload && typeof payload === "object") {
    if ("print" in payload || payload.mode === "print") return "print";
    if ("bundle" in payload || payload.mode === "bundle") return "bundle";
  }
  return "jobs";
};

export const authorizeLabelRendererRequest = (req, operation, options = {}) => {
  const token = extractToken(req, { prefer: "authorization", allowWebhookHeader: false, allowQueryParam: false });
  const role = getJwtRole(token);
  if (!token || !role) {
    return { ok: false, status: 401, message: "Missing or invalid Authorization token" };
  }
  if (role !== "edge_label_renderer_role" && (options.requireDbJwt || role !== "service_role")) {
    return { ok: false, status: 403, message: "Unauthorized role" };
  }
  // This claim policy must be followed by verifyLabelRendererToken before dispatch.
  const claimPolicy = validateInternalEdgeClaims(decodeJwtPayload(token), role, options);
  if (!claimPolicy.ok) return claimPolicy;
  if (!["print", "bundle", "jobs"].includes(operation)) {
    return { ok: false, status: 403, message: "Unauthorized renderer operation" };
  }
  return { ok: true, role };
};

const utf8 = new TextEncoder();
const decodePart = (part) => Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (byte) => byte.charCodeAt(0));
const parsePart = (part) => JSON.parse(new TextDecoder().decode(decodePart(part)));
// shortcut: replay protection is per warm instance for 120 seconds; use a shared store if cross-instance protection is required.
const usedJtis = new Map();
const rejected = { ok: false, status: 401, message: "Invalid renderer invocation token" };

export async function verifyLabelRendererToken(req, signingKey, now = Math.floor(Date.now() / 1000)) {
  if (!signingKey) return { ok: false, status: 503, message: "Renderer signing key is unavailable" };
  const parts = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i.exec(
    req.headers.get("authorization") ?? "",
  );
  if (!parts) return rejected;

  const [, header, payload, signature] = parts;
  try {
    if (parsePart(header)?.alg !== "HS256") return rejected;
    const claims = parsePart(payload);
    if (claims?.iss !== "supabase" || claims.role !== "edge_label_renderer_role" ||
        claims.aud !== "authenticated" || claims.sub !== "edge-function" ||
        !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
        claims.iat > now || claims.exp <= now || claims.exp - claims.iat > 60 ||
        typeof claims.jti !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(claims.jti)) {
      return rejected;
    }

    const key = await crypto.subtle.importKey(
      "raw", utf8.encode(signingKey), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
    if (!(await crypto.subtle.verify("HMAC", key, decodePart(signature), utf8.encode(`${header}.${payload}`)))) {
      return rejected;
    }

    for (const [jti, expires] of usedJtis) if (expires <= now) usedJtis.delete(jti);
    if (usedJtis.has(claims.jti)) return rejected;
    usedJtis.set(claims.jti, now + 120);
    return { ok: true };
  } catch {
    return rejected;
  }
}
