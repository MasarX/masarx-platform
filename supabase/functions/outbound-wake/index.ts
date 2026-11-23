import { readEnv } from "./_shared/mod.mjs";
import { createOutboundWakeHandler } from "./relay.mjs";

const edgeRuntime = (globalThis as typeof globalThis & {
  EdgeRuntime?: { waitUntil(task: Promise<void>): void };
}).EdgeRuntime;

Deno.serve(createOutboundWakeHandler({
  supabaseUrl: readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]),
  anonKey: readEnv("EDGE_SUPABASE_ANON_KEY", ["SUPABASE_ANON_KEY"]),
  dbJwt: readEnv("API_CALLER_DB_JWT"),
  waitUntil: (task: Promise<void>) => edgeRuntime?.waitUntil?.(task),
}));
