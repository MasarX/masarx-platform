import { createSecurityMiddleware } from "../shared/security-middleware";
import { NextResponse, type NextRequest } from "next/server";

// Next.js proxy config must stay statically analyzable (inline literal).
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$).*)",
  ],
};

const consoleProxy = createSecurityMiddleware(process.env.NEXT_PUBLIC_SUPABASE_URL);

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (process.env.NEXT_PUBLIC_FIELDOPS_DEV_HOSTING === "1" &&
      (pathname === "/fieldops" || pathname.startsWith("/fieldops/"))) {
    // Static Expo HTML uses its scoped CSP from next.config, without a dynamic nonce.
    return NextResponse.next();
  }
  return consoleProxy(request);
}
