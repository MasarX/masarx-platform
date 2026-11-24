import { signingDocument } from "./signing-document";

const maxSignatureBytes = 1024 * 1024;

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

function configuredHttpsOrigin(value: string | undefined): string | null {
  const raw = value?.trim() ?? "";
  if (!/^https:\/\/[^\s/\\?#@]+\/?$/i.test(raw)) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function configuration(request: Request) {
  const signingOrigin = configuredHttpsOrigin(process.env.CONTACTLESS_POD_SIGNING_ORIGIN);
  const backendOrigin = configuredHttpsOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
  return signingOrigin && backendOrigin && new URL(request.url).origin === signingOrigin
    ? { signingOrigin, backendOrigin }
    : null;
}

function respond(status: number) {
  return new Response(null, { status, headers: responseHeaders });
}

export function GET(request: Request) {
  if (!configuration(request)) return respond(404);
  const forwardedNonce = request.headers.get("x-nonce") ?? "";
  const nonce = /^[a-f0-9]{32}$/.test(forwardedNonce) ? forwardedNonce : crypto.randomUUID().replaceAll("-", "");
  const preferred = request.headers.get("accept-language")?.split(",", 1)[0]?.trim();
  const language = /^ar(?:-|;|$)/i.test(preferred ?? "") ? "ar" : "en";
  return new Response(signingDocument(nonce, language), {
    headers: {
      ...responseHeaders,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
    },
  });
}

export async function POST(request: Request) {
  const config = configuration(request);
  if (!config || request.headers.get("Origin") !== config.signingOrigin) return respond(403);

  const token = request.headers.get("X-Signing-Token") ?? "";
  if (!/^[a-f0-9]{64}$/.test(token) || request.headers.get("Content-Type") !== "image/png" || !request.body) {
    return respond(400);
  }
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength === null) return respond(411);
  if (!/^\d+$/.test(declaredLength) || Number(declaredLength) === 0) return respond(400);
  const length = Number(declaredLength);
  if (length > maxSignatureBytes) return respond(413);

  const bytes = new Uint8Array(length);
  const reader = request.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length > length - received) {
        void reader.cancel().catch(() => {});
        return respond(value.length > maxSignatureBytes - received ? 413 : 400);
      }
      bytes.set(value, received);
      received += value.length;
    }
  } catch {
    return respond(400);
  } finally {
    reader.releaseLock();
  }
  if (received !== length) return respond(400);

  const forward: RequestInit = {
    method: "POST",
    redirect: "error",
    headers: {
      Origin: config.signingOrigin,
      "Content-Type": "image/png",
      "Content-Length": String(length),
      "X-Signing-Token": token,
    },
    body: bytes,
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
  };
  try {
    const intake = await fetch(new URL("/functions/v1/contactless-pod-intake", config.backendOrigin), forward);
    await intake.body?.cancel();
    return respond([204, 400, 409, 413].includes(intake.status) ? intake.status : 503);
  } catch {
    return respond(503);
  }
}
