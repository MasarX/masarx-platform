/**
 * Shared resource-metrics fetch utility.
 *
 * Shared by server and client callers that need aggregated counts for a
 * set of resource keys with identical fallback semantics:
 *   1. Try the bulk `dashboardMetrics` RPC first, in bounded chunks.
 *   2. Fall back to per-resource `listResource` calls on failure.
 *
 * This module is the SINGLE location for that logic -- callers import
 * {@link fetchResourceMetrics} instead of duplicating the pattern.
 */

/**
 * Minimal client interface required by the metrics fetcher.
 * Matches the subset of `createUiServerClient()` used here so the
 * utility stays decoupled from the full client type.
 */
export type MetricsClient = {
  dashboardMetrics: (
    resourceKeys: string[],
  ) => Promise<{
    metrics?: Array<{ resource: string; total?: number | null }> | null;
  }>;
  listResource: (
    resourceKey: string,
    filters: Record<string, unknown>,
    limit: number,
    offset: number,
    sort?: { key: string; direction?: string | null } | null,
  ) => Promise<{ items: unknown[]; total?: number | null }>;
  resourceMetrics?: (
    resourceKey: string,
    filters?: Record<string, unknown>,
    columns?: string[] | null,
  ) => Promise<{ total?: number | null }>;
};

export type SyntheticMetricQuery = {
  resource: string;
  filters?: Record<string, unknown>;
  columns?: string[] | null;
};

type FetchResourceMetricsOptions = {
  bulkChunkSize?: number;
  disableBulk?: boolean;
  syntheticMetrics?: Record<string, SyntheticMetricQuery>;
};

// Keep the default bulk RPC conservative: the dashboard metrics function fans
// out into per-resource metric probes, so larger batches can trip shared
// authenticated-role statement timeouts on heavier operational surfaces.
const DEFAULT_BULK_CHUNK_SIZE = 6;

function normalizeResourceKeys(resourceKeys: string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of resourceKeys) {
    const key = String(entry ?? "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }
  return normalized;
}

function chunkResourceKeys(resourceKeys: string[], chunkSize: number) {
  const chunks: string[][] = [];
  for (let index = 0; index < resourceKeys.length; index += chunkSize) {
    chunks.push(resourceKeys.slice(index, index + chunkSize));
  }
  return chunks;
}

/**
 * Fetch aggregated resource counts for the given keys.
 *
 * Tries `dashboardMetrics` in bounded chunks first unless bulk is disabled.
 * When a chunk fails or returns incomplete results, falls back to per-key
 * `listResource` calls
 * so the UI always displays _something_.
 *
 * @param client  - UI server client (or compatible subset)
 * @param resourceKeys - resource keys to fetch counts for
 * @param options - optional chunk-size override for bulk RPC calls
 * @returns Map of resource key to count (null when unavailable)
 */
export async function fetchResourceMetrics(
  client: MetricsClient,
  resourceKeys: string[],
  options?: FetchResourceMetricsOptions,
): Promise<Map<string, number | null>> {
  const counts = new Map<string, number | null>();
  const normalizedResourceKeys = normalizeResourceKeys(resourceKeys);
  if (normalizedResourceKeys.length === 0) return counts;
  const syntheticMetrics = options?.syntheticMetrics ?? {};
  const syntheticKeys = new Set(
    normalizedResourceKeys.filter((key) => Boolean(syntheticMetrics[key])),
  );
  const directResourceKeys = normalizedResourceKeys.filter(
    (key) => !syntheticKeys.has(key),
  );

  const applyCount = (resource: string, total: number | null | undefined) => {
    counts.set(
      resource,
      Number.isFinite(total as number) ? Number(total) : null,
    );
  };

  const unresolved = new Set(directResourceKeys);
  if (options?.disableBulk !== true && directResourceKeys.length > 0) {
    const resolvedChunkSize = Math.max(
      1,
      Math.min(32, Math.trunc(Number.isFinite(options?.bulkChunkSize)
        ? options?.bulkChunkSize ?? DEFAULT_BULK_CHUNK_SIZE
        : DEFAULT_BULK_CHUNK_SIZE)),
    );

    // 1. Bulk path, chunked and executed sequentially so heavier dashboard/resource
    // sets do not overlap into authenticated-role statement timeouts.
    for (const chunk of chunkResourceKeys(directResourceKeys, resolvedChunkSize)) {
      try {
        const aggregated = await client.dashboardMetrics(chunk);
        if (Array.isArray(aggregated?.metrics) && aggregated.metrics.length > 0) {
          for (const metric of aggregated.metrics) {
            const resource = String(metric.resource ?? "").trim();
            if (!chunk.includes(resource) || !unresolved.has(resource)) continue;
            applyCount(resource, metric.total ?? null);
            unresolved.delete(resource);
          }
        }
      } catch {
        // Fall through to per-resource listing for unresolved chunk members.
      }
    }
  }

  // 2. Per-resource fallback
  for (const chunk of chunkResourceKeys(Array.from(unresolved), DEFAULT_BULK_CHUNK_SIZE)) {
    await Promise.all(chunk.map(async (resourceKey) => {
      try {
        if (typeof client.resourceMetrics === "function") {
          const metrics = await client.resourceMetrics(resourceKey, {}, null);
          applyCount(resourceKey, metrics?.total ?? null);
          return;
        }
        const list = await client.listResource(resourceKey, {}, 1, 0, null);
        const total =
          typeof list.total === "number" ? list.total : null;
        applyCount(resourceKey, total);
      } catch {
        counts.set(resourceKey, null);
      }
    }));
  }

  for (const chunk of chunkResourceKeys(Array.from(syntheticKeys), DEFAULT_BULK_CHUNK_SIZE)) {
    await Promise.all(chunk.map(async (metricKey) => {
      const query = syntheticMetrics[metricKey];
      if (!query) {
        counts.set(metricKey, null);
        return;
      }
      try {
        if (typeof client.resourceMetrics === "function") {
          const metrics = await client.resourceMetrics(
            query.resource,
            query.filters ?? {},
            query.columns ?? null,
          );
          applyCount(metricKey, metrics?.total ?? null);
          return;
        }
        const list = await client.listResource(
          query.resource,
          query.filters ?? {},
          1,
          0,
          null,
        );
        const total =
          typeof list.total === "number" ? list.total : null;
        applyCount(metricKey, total);
      } catch {
        counts.set(metricKey, null);
      }
    }));
  }

  return counts;
}
