import { handleSignOut } from "@masarx/auth";

export async function GET(request: Request) {
  return handleSignOut(request);
}
