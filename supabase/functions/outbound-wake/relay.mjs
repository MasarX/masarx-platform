import { MAX_BATCH_SIZE } from "../api-caller/invocation.mjs";

// Leave five seconds for delivery jitter between minute sweeps.
const ADMISSION_GAP_MS = 55_000;
const INLINE_ADMISSION_GAP_MS = 2_000;
const MAX_INLINE_BATCHES = 3;

export function createOutboundWakeHandler({ supabaseUrl, anonKey, dbJwt, waitUntil, fetchImpl = fetch }) {
  const baseUrl = supabaseUrl.replace(/\/+$/, "");
  const configured = baseUrl && anonKey && dbJwt.split(".").length === 3;
  let nextAdmissionAt = 0;
  let nextInlineAdmissionAt = 0;
  let inlineWakeScheduled = false;
  if (!configured) console.warn("[outbound-wake] missing server configuration");

  async function wake(inline = false) {
    let stage = "admission";
    try {
      const headers = {
        authorization: `Bearer ${dbJwt}`,
        "content-type": "application/json",
      };
      const rpc = inline ? "try_start_inline_outbound_wake_v1" : "try_start_outbound_wake_v1";
      const admitted = await fetchImpl(`${baseUrl}/rest/v1/rpc/${rpc}`, {
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
      const admission = await admitted.json();
      if (inline) {
        if (!Number.isInteger(admission) || admission < 0) return;
      } else if (admission !== true) return;
      const windowEndsAt = inline ? performance.now() + Math.min(admission, INLINE_ADMISSION_GAP_MS) : 0;

      stage = "dispatch";
      const options = {
        method: "POST",
        headers,
        body: JSON.stringify({ batch: MAX_BATCH_SIZE }),
        redirect: "error",
        // Bound the entire drain to the existing job lease window.
        signal: AbortSignal.timeout(720_000),
      };
      const batchLimit = inline ? MAX_INLINE_BATCHES : 1;
      for (let batch = 1; batch <= batchLimit; batch += 1) {
        const worker = await fetchImpl(`${baseUrl}/functions/v1/api-caller`, options);
        if (!worker.ok || batch === batchLimit) {
          await worker.body?.cancel();
          if (!worker.ok) throw new Error();
          return;
        }
        const full = (await worker.json())?.summary?.claimed === MAX_BATCH_SIZE;
        const remaining = windowEndsAt - performance.now();
        if (!full && remaining <= 0) return;
        // Start immediately and save a pass for handoffs coalesced behind this signal.
        if (remaining > 0 && (!full || batch === batchLimit - 1)) {
          await new Promise(resolve => setTimeout(resolve, remaining));
        }
      }
    } catch {
      console.warn(`[outbound-wake] ${stage} failed`);
    }
  }

  async function wakeInline() {
    const delay = nextInlineAdmissionAt - performance.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    nextInlineAdmissionAt = performance.now() + INLINE_ADMISSION_GAP_MS;
    inlineWakeScheduled = false;
    await wake(true);
  }

  return (request) => {
    if (configured && request.method === "POST") {
      if (request.url && new URL(request.url).searchParams.get("inline") === "1") {
        if (!inlineWakeScheduled) {
          inlineWakeScheduled = true;
          waitUntil(wakeInline());
        }
      } else {
        const now = performance.now();
        if (now >= nextAdmissionAt) {
          // The database still decides admission across instances.
          nextAdmissionAt = now + ADMISSION_GAP_MS;
          waitUntil(wake());
        }
      }
    }
    return new Response(null, { status: 202 });
  };
}
