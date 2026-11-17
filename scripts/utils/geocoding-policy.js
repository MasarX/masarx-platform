function normalizeGeocodingPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  // Legacy key: geocoding_policy.enabled (top-level). Strip to keep config schema strict.
  const normalized = { ...value };
  delete normalized.enabled;
  return normalized;
}

module.exports = {
  normalizeGeocodingPolicy,
};

