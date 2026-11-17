export type HrefParams =
  | URLSearchParams
  | Record<string, string | number | boolean | null | undefined>;

export function buildHref(base: string, params?: HrefParams) {
  if (!params) return base;
  const searchParams =
    params instanceof URLSearchParams
      ? params
      : new URLSearchParams(
          Object.entries(params).flatMap(([key, value]) =>
            value === null || value === undefined ? [] : [[key, String(value)]]
          )
        );
  const query = searchParams.toString();
  return query ? `${base}?${query}` : base;
}
