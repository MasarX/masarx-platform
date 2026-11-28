const maxSignatureBytes = 1024 * 1024;
const pngHeader = [137, 80, 78, 71, 13, 10, 26, 10];
const pngEnd = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
const evidenceBucket = "fieldops-evidence";

async function readSignature(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.headers.get("Content-Type") !== "image/png" || !request.body) return null;
  const declared = request.headers.get("Content-Length") ?? "";
  const size = Number(declared);
  if (!/^\d+$/.test(declared) || size < 45 || size > maxSignatureBytes) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(size);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length > size - length) {
        void reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(value, length);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  if (length !== size || !pngHeader.every((part, index) => bytes[index] === part) ||
      !pngEnd.every((part, index) => bytes[size - pngEnd.length + index] === part)) return null;
  const header = new DataView(bytes.buffer);
  if (header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452 ||
      header.getUint32(16) < 1 || header.getUint32(16) > 4096 ||
      header.getUint32(20) < 1 || header.getUint32(20) > 4096) return null;
  let hasImageData = false;
  for (let offset = 33; offset <= size - 12;) {
    const chunkLength = header.getUint32(offset);
    const chunkType = header.getUint32(offset + 4);
    if (chunkLength > size - offset - 12) return null;
    if (chunkType === 0x49454e44) return hasImageData && offset === size - 12 ? bytes : null;
    if (chunkType === 0x49444154 && chunkLength > 0) hasImageData = true;
    offset += chunkLength + 12;
  }
  return null;
}

function signingOrigin(): string | null {
  try {
    const url = new URL(Deno.env.get("CONTACTLESS_POD_SIGNING_ORIGIN")?.trim() ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

Deno.serve(async (request) => {
  const origin = signingOrigin();
  if (!origin || request.headers.get("Origin") !== origin) return new Response(null, { status: 403 });
  const headers = new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Signing-Token",
    "Cache-Control": "no-store",
    Vary: "Origin",
  });
  const respond = (status: number) => new Response(null, { status, headers });
  if (request.method === "OPTIONS") return respond(204);
  if (request.method !== "POST") return respond(405);

  const token = request.headers.get("X-Signing-Token") ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) return respond(400);
  const url = Deno.env.get("EDGE_SUPABASE_URL") || Deno.env.get("SUPABASE_URL");
  const apiKey = Deno.env.get("SUPABASE_ANON_KEY");
  const intakeJwt = Deno.env.get("CONTACTLESS_POD_DB_JWT");
  const storageKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !apiKey || !intakeJwt || !storageKey) return respond(503);

  const rpc = async (name: string, args: Record<string, string | number | null>) => {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        "Content-Profile": "api",
        "apikey": apiKey,
        Authorization: `Bearer ${intakeJwt}`,
      },
      body: JSON.stringify({ p_token: token, ...args }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Signing intake unavailable.");
    }
    return response.json();
  };
  const storageHeaders = { apikey: storageKey, Authorization: `Bearer ${storageKey}` };
  const bucketUrl = `${url}/storage/v1/object/${evidenceBucket}`;
  let attemptId: string | undefined;
  let objectKey: string | undefined;
  let uploadStarted = false;
  let submitted = false;
  const discard = async () => {
    const cleanup: Promise<unknown>[] = [];
    if (attemptId) {
      cleanup.push(rpc("submit_contactless_pod_v1", {
        p_attempt_id: attemptId, p_signature_sha256: null, p_signature_length: null,
      }));
    }
    if (uploadStarted && objectKey) {
      cleanup.push(fetch(bucketUrl, {
        method: "DELETE",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { ...storageHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: [objectKey] }),
      }).then((response) => response.body?.cancel()));
    }
    await Promise.allSettled(cleanup);
  };

  try {
    const attempt = await rpc("begin_contactless_pod_attempt_v1", {});
    if (!attempt) return respond(409);
    if (typeof attempt.attempt_id !== "string" || typeof attempt.storage_key !== "string") return respond(503);
    const storagePath = /^([a-f0-9-]{36})\/([a-f0-9-]{36})\/customer-signature-([a-f0-9-]{36})\.png$/.exec(attempt.storage_key);
    if (storagePath?.[3] !== attempt.attempt_id) return respond(503);
    attemptId = attempt.attempt_id;
    objectKey = attempt.storage_key;
    const signature = await readSignature(request);
    if (!signature) {
      await discard();
      return respond(400);
    }
    const hash = await crypto.subtle.digest("SHA-256", signature);
    const digest = Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
    uploadStarted = true;
    const upload = await fetch(`${bucketUrl}/${objectKey.split("/").map(encodeURIComponent).join("/")}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { ...storageHeaders, "Content-Type": "image/png", "x-upsert": "false" },
      body: signature,
    });
    await upload.body?.cancel();
    if (!upload.ok) {
      await discard();
      return respond(503);
    }
    submitted = true;
    const accepted = await rpc("submit_contactless_pod_v1", {
      p_attempt_id: attemptId,
      p_signature_sha256: digest,
      p_signature_length: signature.length,
    });
    if (accepted === true) return respond(204);
    if (accepted !== false) return respond(503);
    await discard();
    return respond(409);
  } catch {
    // A lost finalize response may follow a committed proof. Preserve that object.
    if (!submitted) await discard();
    return respond(503);
  }
});
