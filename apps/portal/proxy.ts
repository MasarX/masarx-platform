import { createSecurityMiddleware } from "../shared/security-middleware";

// Next.js proxy config must stay statically analyzable (inline literal).
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$).*)",
  ],
};

export const proxy = createSecurityMiddleware(process.env.NEXT_PUBLIC_SUPABASE_URL);
