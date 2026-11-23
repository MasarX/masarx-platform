const encodeBase64Url = (value) => btoa(String.fromCharCode(...value))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const utf8 = new TextEncoder();

export async function authorizeRendererSend(dispatch, rendererEndpoint, signingSecret) {
  const expected = new URL(rendererEndpoint);
  const destination = new URL(dispatch.url);
  if (expected.protocol !== "https:" || !expected.pathname.endsWith("/functions/v1/label-renderer") ||
      destination.href !== expected.href ||
      destination.username || destination.password || destination.search || destination.hash) {
    throw new Error("renderer_endpoint_not_authorized");
  }
  if (!signingSecret) throw new Error("renderer_signer_unavailable");

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    role: "edge_label_renderer_role",
    iss: "supabase",
    sub: "edge-function",
    aud: "authenticated",
    iat: now,
    exp: now + 60,
    jti: crypto.randomUUID(),
  };
  const header = encodeBase64Url(utf8.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = encodeBase64Url(utf8.encode(JSON.stringify(claims)));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw", utf8.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, utf8.encode(unsigned));

  return {
    ...dispatch,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${unsigned}.${encodeBase64Url(new Uint8Array(signature))}`,
    },
  };
}
