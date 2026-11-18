const CANONICAL_API_INGRESS_PUBLIC_HOST_PATTERN = /^api(?:-dev|-stg)?\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const BLOCKED_API_INGRESS_PUBLIC_HOST_PATTERN = /(?:tile\.openstreetmap\.org$|mapbox|googleapis|virtualearth|bing\.com|hereapi|tomtom|maptiler|arcgis)/;
function normalizeApiIngressPublicHost(value, options = {}) {
  const publicHost = String(value || '').trim().toLowerCase();
  if (!publicHost) {
    if (options.required) throw new Error('API_INGRESS_PUBLIC_HOST is required.');
    return '';
  }
  if (!CANONICAL_API_INGRESS_PUBLIC_HOST_PATTERN.test(publicHost) ||
      publicHost.endsWith('.localhost') ||
      BLOCKED_API_INGRESS_PUBLIC_HOST_PATTERN.test(publicHost)) {
    throw new Error('API_INGRESS_PUBLIC_HOST must be a bare canonical api-dev, api-stg, or api hostname.');
  }
  return publicHost;
}
module.exports = { CANONICAL_API_INGRESS_PUBLIC_HOST_PATTERN,
  BLOCKED_API_INGRESS_PUBLIC_HOST_PATTERN, normalizeApiIngressPublicHost };
