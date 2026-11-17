import { NextResponse, type NextRequest } from "next/server";
import securityHeadersModule from "./security-headers";

const { buildSecurityHeaders } = securityHeadersModule as {
  buildSecurityHeaders: (params: {
    supabaseUrl?: string;
    nodeEnv?: string;
    nonce?: string;
  }) => Array<{ key: string; value: string }>;
};

function makeNonce() {
  return crypto.randomUUID().replace(/-/g, "");
}

export function createSecurityMiddleware(supabaseUrl?: string) {
  return function securityMiddleware(request: NextRequest) {
    const nonce = makeNonce();
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);

    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });

    const headers = buildSecurityHeaders({
      supabaseUrl,
      nodeEnv: process.env.NODE_ENV,
      nonce,
    });
    headers.forEach(({ key, value }) => {
      response.headers.set(key, value);
    });
    response.headers.set("x-nonce", nonce);
    return response;
  };
}
