import { extractToken, getJwtRole } from "./_shared/mod.mjs";

const handler = async (req: Request): Promise<Response> => {
  const token = extractToken(req, { prefer: "authorization", allowWebhookHeader: false, allowQueryParam: false });
  const role = getJwtRole(token);
  if (!token || !role) {
    return new Response(JSON.stringify({ error: "Missing or invalid Authorization token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  if (role !== "service_role" && role !== "edge_api_caller_role") {
    return new Response(JSON.stringify({ error: "Unauthorized role" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method === "GET") {
    return new Response(null, { status: 204 });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  const body = await req.json().catch(() => ({}));
  return new Response(JSON.stringify({ received: body, ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

Deno.serve(handler);
