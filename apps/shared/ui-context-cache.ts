import "server-only";

import { createHash } from "crypto";
import { isRetriableNetworkError, isRetriableSupabaseError } from "@masarx/api";
import type { UiMe, UiNavigation } from "@masarx/api";

type UiContext = { me: UiMe; navigation: UiNavigation };

type CacheEntry = {
  value: UiContext;
  expiresAt: number;
  staleUntil: number;
};

const DEFAULT_TTL_MS = 20_000;
const DEFAULT_STALE_IF_ERROR_MS = 300_000;
const DEFAULT_MAX_ENTRIES = 250;

const resolveNumberEnv = (value: string | undefined, fallback: number) => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
};

const resolveTtlMs = () =>
  Math.max(0, resolveNumberEnv(process.env.MASARX_UI_CONTEXT_CACHE_TTL_MS, DEFAULT_TTL_MS));

const resolveStaleIfErrorMs = () =>
  Math.max(
    0,
    resolveNumberEnv(
      process.env.MASARX_UI_CONTEXT_CACHE_STALE_IF_ERROR_MS,
      DEFAULT_STALE_IF_ERROR_MS
    )
  );

const resolveMaxEntries = () =>
  Math.max(
    10,
    resolveNumberEnv(process.env.MASARX_UI_CONTEXT_CACHE_MAX_ENTRIES, DEFAULT_MAX_ENTRIES)
  );

const contextCache = new Map<string, CacheEntry>();
const contextInflight = new Map<string, Promise<UiContext>>();

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function pruneExpired(now: number) {
  for (const [key, entry] of contextCache.entries()) {
    if (entry.staleUntil <= now) {
      contextCache.delete(key);
    }
  }

  const maxEntries = resolveMaxEntries();
  if (contextCache.size <= maxEntries) return;

  for (const key of contextCache.keys()) {
    contextCache.delete(key);
    if (contextCache.size <= maxEntries) return;
  }
}

export async function loadUiContextCached(params: {
  appKey: string;
  accessToken: string;
  load: () => Promise<UiContext>;
}): Promise<UiContext> {
  const ttlMs = resolveTtlMs();
  if (ttlMs === 0) {
    return params.load();
  }

  const tokenHash = hashToken(params.accessToken);
  const cacheKey = `${params.appKey}:${tokenHash}`;
  const now = Date.now();
  const cached = contextCache.get(cacheKey);
  const cachedFresh = cached && cached.expiresAt > now ? cached.value : null;
  if (cachedFresh) return cachedFresh;

  const staleIfErrorMs = resolveStaleIfErrorMs();
  const cachedStale =
    cached &&
    staleIfErrorMs > 0 &&
    cached.staleUntil > now
      ? cached
      : null;

  const inflight = contextInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const promise = params
    .load()
    .then((value) => {
      const expiresAt = Date.now() + ttlMs;
      contextCache.set(cacheKey, {
        value,
        expiresAt,
        staleUntil: expiresAt + staleIfErrorMs,
      });
      pruneExpired(Date.now());
      return value;
    })
    .catch((error) => {
      if (
        cachedStale &&
        cachedStale.staleUntil > Date.now() &&
        (isRetriableNetworkError(error) || isRetriableSupabaseError(error))
      ) {
        // Throttle retries without extending the last successful load's stale window.
        const expiresAt = Math.min(Date.now() + ttlMs, cachedStale.staleUntil);
        contextCache.set(cacheKey, { ...cachedStale, expiresAt });
        pruneExpired(Date.now());
        return cachedStale.value;
      }
      throw error;
    })
    .finally(() => {
      contextInflight.delete(cacheKey);
    });

  contextInflight.set(cacheKey, promise);
  return promise;
}
