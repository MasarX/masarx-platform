import { resolveTrackingConfig } from "../../../packages/ui/src/tracking-config";
import { createAuthedSupabaseClient, rpcWithRetry, signOutSupabaseClient } from "./supabase";

export async function fetchTrackingConfig(params: {
  email: string;
  password: string;
}) {
  const { email, password } = params;
  const supabase = await createAuthedSupabaseClient({
    email,
    password,
    label: `tracking:${email}`,
  });

  try {
    const { data, error } = await rpcWithRetry(supabase, "ui_tracking_registry_v1", null, {
      label: `ui_tracking_registry_v1:${email}`,
    });
    if (error) {
      throw new Error(
        `Failed to read ui_tracking_registry_v1: ${(error as any)?.message || String(error)}`
      );
    }
    return resolveTrackingConfig(data ?? null);
  } finally {
    await signOutSupabaseClient(supabase, { label: `tracking:${email}` });
  }
}
