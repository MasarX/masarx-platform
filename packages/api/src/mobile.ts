import type { SupabaseClient } from "@supabase/supabase-js";
import { createUiClientFromSupabase } from "./ui-client";

export { normalizeNavigation } from "./navigation-normalize";
export { createUiClientFromSupabase } from "./ui-client";

export function createMobileUiClient(client: SupabaseClient<any, any, any, any, any>) {
  return createUiClientFromSupabase(client);
}
