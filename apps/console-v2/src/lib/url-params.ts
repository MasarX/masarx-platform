export type UrlParamSource = {
  search?: string;
  hash?: string;
};

function currentUrlSource(): UrlParamSource {
  if (typeof window === 'undefined') return { search: '', hash: '' };
  return { search: window.location.search, hash: window.location.hash };
}

function hashQuery(hash: string | undefined): string {
  if (!hash?.includes('?')) return '';
  return hash.slice(hash.indexOf('?') + 1);
}

export function readUrlParam(name: string, source: UrlParamSource = currentUrlSource()): string | null {
  const fromSearch = new URLSearchParams(source.search ?? '').get(name)?.trim();
  if (fromSearch) return fromSearch;

  const fromHash = new URLSearchParams(hashQuery(source.hash)).get(name)?.trim();
  return fromHash || null;
}
