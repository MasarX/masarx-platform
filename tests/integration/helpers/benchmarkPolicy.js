function providerOnlyBenchmarkPolicy() {
  return {
    provider_priority: ['here_geocoding'],
    local_lookup: { enabled: false },
    matching_plugins: [],
    logging: { log_scoring_details: true },
    confidence_threshold: 0.01,
    fallback_threshold: 0.005,
  };
}

module.exports = { providerOnlyBenchmarkPolicy };
