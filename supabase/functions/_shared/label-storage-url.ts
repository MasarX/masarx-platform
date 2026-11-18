export const projectSignedStorageUrlForResponse = (
  value: string,
  internalBaseUrl: string,
  publicBaseUrl: string,
) => {
  const normalized = String(value || '').trim();
  if (!normalized || !publicBaseUrl) return normalized;
  try {
    const signed = new URL(normalized);
    const internal = new URL(internalBaseUrl);
    const external = new URL(publicBaseUrl);
    if (!['http:', 'https:'].includes(external.protocol)) {
      throw new Error('public Supabase URL must use http or https');
    }
    if (signed.origin !== internal.origin || !signed.pathname.startsWith('/storage/v1/')) {
      return normalized;
    }
    return `${external.origin}${signed.pathname}${signed.search}${signed.hash}`;
  } catch (error) {
    throw new Error(
      `Cannot project signed storage URL to public origin: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
