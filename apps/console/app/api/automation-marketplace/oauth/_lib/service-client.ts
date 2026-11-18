import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getPublicConfig } from "@masarx/config";
import { createServerReachableFetch } from "@masarx/auth/server";

export function createOAuthServiceClient() {
  const { supabaseUrl } = getPublicConfig();
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!key || !supabaseUrl) throw new Error("OAuth service configuration is unavailable.");
  const serverFetch = createServerReachableFetch(supabaseUrl);
  return createClient(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: "api" },
    ...(serverFetch ? { global: { fetch: serverFetch } } : {}),
  });
}
