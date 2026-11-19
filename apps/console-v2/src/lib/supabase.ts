// supabase.ts — single swap-seam factory.
//
// Returns the Supabase client when VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.
// Returns null when env vars are absent — adapters in data-source.ts use this to
// branch between live RPC and the in-memory mock without breaking the swap-seam contract.
//
// The cutover from in-memory to live is a pure environment change: set the two env
// vars and every adapter automatically routes through supabase.rpc(). No source edits.
//
// See README.md "Production checklist" and the data-source.ts header for the full
// swap-seam pattern.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type ConsoleSupabaseClient = SupabaseClient<any, any, any>;

let cached: ConsoleSupabaseClient | null | undefined;

/**
 * Returns the Supabase client when VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.
 * Returns null when env vars are absent — adapters in data-source.ts use this to
 * branch between live RPC and in-memory mock without breaking the swap-seam contract.
 *
 * The cutover from in-memory to live is a pure environment change: set the two env
 * vars and every adapter automatically routes through supabase.rpc(). No source edits.
 *
 * Single SSOT: this factory is the only seam that decides live-vs-memory. Vitest
 * does not branch here; instead, MSW handlers (`src/test/msw/handlers.ts`) cover
 * the canonical RPC contract and intercept any HTTP that adapters issue when
 * env vars are present. Keeping vitest on the same surface as production
 * preserves the "FE→RPC contract" SSOT for both unit tests and the local
 * Supabase E2E flow.
 */
export function getSupabaseClient(): ConsoleSupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !key) {
    cached = null;
    return null;
  }
  cached = createClient(url, key, {
    db: { schema: 'api' },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
      storageKey: 'masarx-console-v2-auth',
    },
    global: { headers: { 'x-client-info': 'console-v2' } },
  });
  return cached;
}

/** For tests only — reset memoization so the factory re-reads env. */
export function __resetSupabaseClientForTests(): void {
  cached = undefined;
}

/**
 * Helper to call a canonical RPC. Wraps error handling consistently.
 * Returns null when env is not set so adapters can fall through to in-memory paths.
 *   const data = await rpc<ListResult<Shipment>>('ui_list_resource_v1', { resource_key: 'shipments' });
 */
export async function rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T | null> {
  const sb = getSupabaseClient();
  if (!sb) return null;
  const target = typeof sb.schema === 'function' ? sb.schema('api') : sb;
  const { data, error } = await target.rpc(fn, args);
  if (error) throw error;
  return data as T;
}
