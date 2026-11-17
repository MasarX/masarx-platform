import type { SupabaseClient } from "@supabase/supabase-js";

export async function resolvePolicyRow(
  client: Pick<SupabaseClient<any, any, any, any, any>, "rpc">,
  rpcName: string,
  policyContext: Record<string, unknown>
) {
  const { data, error } = await client.rpc(rpcName as any, { p_context: policyContext } as any);
  if (error) {
    const message = String((error as any)?.message || "");
    if (message.includes("Could not find the function")) return null;
    throw error;
  }
  if (!Array.isArray(data)) return null;
  return data[0] ?? null;
}

