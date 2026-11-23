export function createOutboundWakeHandler({ supabaseUrl, anonKey, dbJwt, waitUntil, fetchImpl = fetch }) {
  const baseUrl = supabaseUrl.replace(/\/+$/, "");
  const configured = baseUrl && anonKey && dbJwt.split(".").length === 3;
  if (!configured) console.warn("[outbound-wake] missing server configuration");

  async function wake() {
    let stage = "admission";
    try {
      const headers = {
        authorization: `Bearer ${dbJwt}`,
        "content-type": "application/json",
      };
      const admitted = await fetchImpl(`${baseUrl}/rest/v1/rpc/try_start_outbound_wake_v1`, {
        method: "POST",
        headers: { ...headers, apikey: anonKey, "content-profile": "api" },
        body: "{}",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!admitted.ok) {
        await admitted.body?.cancel();
        throw new Error();
      }
      if (await admitted.json() !== true) return;

      stage = "dispatch";
      const worker = await fetchImpl(`${baseUrl}/functions/v1/api-caller`, {
        method: "POST",
        headers,
        body: JSON.stringify({ batch: 1 }),
        redirect: "error",
        // Bound the hop to the existing job lease window.
        signal: AbortSignal.timeout(720_000),
      });
      await worker.body?.cancel();
      if (!worker.ok) throw new Error();
    } catch {
      console.warn(`[outbound-wake] ${stage} failed`);
    }
  }

  return (request) => {
    if (configured && request.method === "POST") waitUntil(wake());
    return new Response(null, { status: 202 });
  };
}
