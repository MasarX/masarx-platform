import {
  authorizeApiCallerOperation,
  authorizeEdgeRequest,
  extractAuthToken,
} from "../../../supabase/functions/api-caller/auth.mjs";

const payload = JSON.parse(process.argv[2]);
if (Object.prototype.hasOwnProperty.call(payload || {}, "roles")) {
  const roles = payload?.roles;
  if (roles && String(roles).trim()) {
    process.env.EDGE_INTERNAL_CALLER_ROLES = String(roles);
  } else {
    delete process.env.EDGE_INTERNAL_CALLER_ROLES;
  }
}
const req = new Request("https://example.test", { method: "POST", headers: payload.headers });
const auth = await authorizeEdgeRequest(req, {
  ...(Object.prototype.hasOwnProperty.call(payload, "claims") ? { claims: payload.claims } : {}),
  nowSeconds: payload.nowSeconds,
});
const result = {
  token: extractAuthToken(req),
  auth,
  operationAuth: payload.operation
    ? authorizeApiCallerOperation(auth, payload.operation)
    : null,
};

console.log(JSON.stringify(result));
