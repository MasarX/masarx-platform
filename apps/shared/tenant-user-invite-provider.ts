import "server-only";
import { createClient } from "@supabase/supabase-js";
import { createServerReachableFetch } from "@masarx/auth/server";
import { getPublicConfig } from "@masarx/config";

export function createTenantUserInviteProviderClient() {
  const { supabaseUrl, supabaseAnonKey } = getPublicConfig();
  const key = [process.env.SUPABASE_SECRET_KEY, process.env.EDGE_SUPABASE_SECRET_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.SERVICE_ROLE_KEY, process.env.SUPABASE_SERVICE_KEY]
    .map((value) => value?.trim()).find(Boolean);
  if (!supabaseUrl || !key) throw new Error("provider_configuration_missing");
  const serverFetch = createServerReachableFetch(supabaseUrl) ?? fetch;
  return createClient(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: "api" },
    global: {
      headers: { apikey: key.split(".").length === 3 ? supabaseAnonKey : key },
      fetch: (input, init) => serverFetch(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      }),
    },
  });
}
