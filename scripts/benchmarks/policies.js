function providerOnlyPolicy() {
  return {
    provider_priority: ['here_geocoding'],
    local_lookup: { enabled: false },
    matching_plugins: [
      { name: 'reverse', enabled: true },
      { name: 'reverse_local', enabled: true },
    ],
    logging: { log_scoring_details: true },
  };
}

function providerRequiredPolicy(base = {}) {
  return {
    provider_priority: ['here_geocoding'],
    local_lookup: { enabled: false },
    matching_plugins: [
      { name: 'perfect', enabled: false },
      { name: 'fuzzy', enabled: false },
      { name: 'reverse', enabled: true },
      { name: 'reverse_local', enabled: true },
    ],
    logging: { log_scoring_details: true },
    ...base,
  };
}

module.exports = {
  providerOnlyPolicy,
  providerRequiredPolicy,
};
