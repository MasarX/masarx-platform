import { createBrowserClient as createSupabaseBrowserClient } from "@supabase/ssr";
import { getPublicConfig } from "@masarx/config";

export function createBrowserClient() {
  const { supabaseUrl, supabaseAnonKey } = getPublicConfig();
  return createSupabaseBrowserClient(supabaseUrl, supabaseAnonKey, {
    db: { schema: "api" },
    cookieEncoding: "base64url",
  });
}
