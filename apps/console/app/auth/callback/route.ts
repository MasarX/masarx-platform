import { handleAuthCallback } from "@masarx/auth";

export async function GET(request: Request) {
  return handleAuthCallback(request);
}
