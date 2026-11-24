import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { MAX_LOGO_BYTES, stripProofImageMetadata } from "./_shared/raster-images.mjs";

type ProofArtifact = {
  id: string;
  kind: "photo" | "signature";
  captured_at: string;
  storage_bucket: string;
  storage_key: string;
  mime_type: string;
};

type ProofResponse = {
  ok: true;
  session_id: string;
  organization_id: string;
  session_expires_at: string | null;
  proof: {
    state: "available" | "unavailable" | "expired";
    available_until: string | null;
    recipient_name: string | null;
    artifacts: ProofArtifact[];
  };
} | { ok: false; error: { code: string } };

const storageKeyShape = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(\/[A-Za-z0-9._-]+)+$/;
const encoder = new TextEncoder();
const linkData = (sessionId: string, artifactId: string, expiry: number) =>
  encoder.encode(JSON.stringify(["public-tracking-proof-v1", sessionId, artifactId, expiry]));

async function loadProofImage<Schema extends string>(
  client: SupabaseClient<any, Schema>,
  organizationId: string,
  artifact: ProofArtifact,
) {
  const { storage_key: path, storage_bucket: bucket } = artifact;
  if (bucket !== "fieldops-evidence" || typeof path !== "string" ||
      !storageKeyShape.test(path) || !path.startsWith(organizationId + "/") ||
      /(^|\/)\.{1,2}(\/|$)/.test(path)) return null;

  try {
    const { data, error } = await client.storage.from(bucket)
      .download(path, {}, { signal: AbortSignal.timeout(5000) }).asStream();
    if (error || !data) return null;

    const reader = data.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_LOGO_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const raw = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      raw.set(chunk, offset);
      offset += chunk.length;
    }
    const mime = artifact.mime_type === "image/jpg" ? "image/jpeg" : artifact.mime_type;
    const bytes = stripProofImageMetadata(raw, mime);
    return bytes ? { bytes, mime } : null;
  } catch {
    return null;
  }
}

export async function serveTrackingProof<Schema extends string>(
  client: SupabaseClient<any, Schema>,
  input: Record<string, unknown>,
  requestUrl: URL,
  corsHeaders: HeadersInit,
  signingSecret: string,
): Promise<Response> {
  const headers = new Headers(corsHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  const reply = (status: number, body: unknown) => {
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status, headers });
  };
  const unavailable = () => reply(404, { ok: false, error: { code: "proof_unavailable" } });

  const isFile = requestUrl.pathname.replace(/\/+$/, "").endsWith("/proof/file");
  const artifactId = requestUrl.searchParams.get("artifact") ?? "";
  const expiry = Number(requestUrl.searchParams.get("expires"));
  const signature = requestUrl.searchParams.get("signature") ?? "";
  const now = Math.floor(Date.now() / 1000);

  if (isFile && (!Number.isSafeInteger(expiry) || expiry <= now || !/^[a-f0-9]{64}$/.test(signature))) {
    return unavailable();
  }

  // Supply only values used by the existing session validator.
  const { data, error } = await client.rpc("public_tracking_proof_v1", {
    p_input: { session_token: input.session_token, ip_hash: input.ip_hash },
  });
  if (error || !data) return reply(500, { ok: false, error: { code: "rpc_failed" } });
  const result = data as ProofResponse;
  if (!result.ok) return reply(result.error.code === "rate_limited" ? 429 : 401, result);

  const proof = result.proof;
  if (proof.state !== "available") {
    if (isFile) return unavailable();
    return reply(200, { ok: true, proof: { state: proof.state, available_until: proof.available_until, recipient_name: null, artifacts: [] } });
  }

  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
  const cap = Math.floor(Math.min(
    Date.parse(proof.available_until ?? ""),
    result.session_expires_at ? Date.parse(result.session_expires_at) : Infinity,
  ) / 1000);
  if (!Number.isFinite(cap) || cap <= now) return unavailable();

  if (isFile) {
    const artifact = proof.artifacts.find((item) => item.id === artifactId);
    const signatureBytes = Uint8Array.from(signature.match(/../g) ?? [], (value) => parseInt(value, 16));
    if (!artifact || expiry > cap ||
        !await crypto.subtle.verify("HMAC", key, signatureBytes, linkData(result.session_id, artifactId, expiry))) {
      return unavailable();
    }
    const image = await loadProofImage(client, result.organization_id, artifact);
    if (!image || Date.now() >= expiry * 1000) return unavailable();
    headers.set("Content-Type", image.mime);
    headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
    return new Response(image.bytes, { status: 200, headers });
  }

  // Artifact records do not store dimensions. Check the same bytes and limits as the file route.
  const eligible = (await Promise.all(proof.artifacts.map(async (artifact) =>
    await loadProofImage(client, result.organization_id, artifact) ? artifact : null
  ))).filter((artifact) => artifact !== null);
  if (!eligible.length) {
    return reply(200, { ok: true, proof: { state: "unavailable", available_until: null, recipient_name: null, artifacts: [] } });
  }
  const listedAt = Math.floor(Date.now() / 1000);
  if (cap <= listedAt) return unavailable();
  const linkExpiry = Math.min(cap, listedAt + 600);
  const artifacts = await Promise.all(eligible.map(async (artifact) => {
    const digest = await crypto.subtle.sign("HMAC", key, linkData(result.session_id, artifact.id, linkExpiry));
    const signature = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    const query = new URLSearchParams({ artifact: artifact.id, expires: String(linkExpiry), signature });
    return {
      kind: artifact.kind, captured_at: artifact.captured_at,
      url: "/functions/v1/public-shipment-tracking/proof/file?" + query.toString(),
    };
  }));
  return reply(200, {
    ok: true,
    proof: {
      state: proof.state, available_until: proof.available_until,
      recipient_name: proof.recipient_name, artifacts,
    },
  });
}
