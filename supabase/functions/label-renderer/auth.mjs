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
  // Decoding is not signature verification. Keep native verify_jwt enabled.
  const claimPolicy = validateInternalEdgeClaims(decodeJwtPayload(token), role, options);
  if (!claimPolicy.ok) return claimPolicy;
  if (!["print", "bundle", "jobs"].includes(operation)) {
    return { ok: false, status: 403, message: "Unauthorized renderer operation" };
  }
  return { ok: true, role };
};
