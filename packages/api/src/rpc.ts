import type { SupabaseClient } from "@supabase/supabase-js";
import { isRetriableNetworkError, isRetriableSupabaseError } from "./retry";

type RpcArgs = Record<string, unknown> | undefined;

const DEFAULT_RPC_RETRIES = 2;
const DEFAULT_RPC_MIN_DELAY_MS = 150;
const DEFAULT_RPC_MAX_DELAY_MS = 1200;

const resolveNumberEnv = (value: string | undefined, fallback: number) => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
};

const resolveRpcRetries = () =>
  resolveNumberEnv(process.env.MASARX_RPC_RETRIES, DEFAULT_RPC_RETRIES);
const resolveRpcMinDelayMs = () =>
  resolveNumberEnv(process.env.MASARX_RPC_RETRY_MIN_DELAY_MS, DEFAULT_RPC_MIN_DELAY_MS);
const resolveRpcMaxDelayMs = () =>
  resolveNumberEnv(process.env.MASARX_RPC_RETRY_MAX_DELAY_MS, DEFAULT_RPC_MAX_DELAY_MS);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function resolveRetryDelayMs(attempt: number) {
  const minDelay = Math.max(0, resolveRpcMinDelayMs());
  const maxDelay = Math.max(minDelay, resolveRpcMaxDelayMs());
  const base = Math.min(maxDelay, minDelay * Math.pow(2, attempt));
  const jitter = Math.round(base * (0.2 * Math.random()));
  return Math.min(maxDelay, base + jitter);
}

export function createRpc(client: SupabaseClient) {
  return async function rpc<T>(fn: string, args?: RpcArgs) {
    const retries = Math.max(0, resolveRpcRetries());

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const { data, error } = await client.rpc(fn, args);
        if (error) {
          if (attempt < retries && isRetriableSupabaseError(error)) {
            await sleep(resolveRetryDelayMs(attempt));
            continue;
          }
          throw error;
        }
        return data as T;
      } catch (error) {
        if (attempt < retries && isRetriableNetworkError(error)) {
          await sleep(resolveRetryDelayMs(attempt));
          continue;
        }
        throw error;
      }
    }

    throw new Error(`RPC ${fn} failed after ${retries + 1} attempts.`);
  };
}
