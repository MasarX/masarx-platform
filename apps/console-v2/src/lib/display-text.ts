export function humanizeToken(value: unknown, fallback = 'Not set'): string {
  if (value == null) return fallback;
  const raw = String(value).trim();
  if (!raw) return fallback;

  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._:/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!spaced) return fallback;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
