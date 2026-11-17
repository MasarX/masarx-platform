import { authorizeEdgeRequest, extractAuthToken } from "../../../supabase/functions/api-caller/auth.mjs";

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
const result = {
  token: extractAuthToken(req),
  auth: authorizeEdgeRequest(req)
};

console.log(JSON.stringify(result));

