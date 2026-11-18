'use strict';

function parseOriginList(value) {
  const seen = new Set();
  const origins = [];

  for (const item of String(value || '').split(',')) {
    const origin = item.trim();
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    origins.push(origin);
  }

  return origins;
}

function resolveAllowedDevOrigins(env = process.env) {
  return parseOriginList(
    env.NEXT_ALLOWED_DEV_ORIGINS ||
    env.NEXT_PUBLIC_ALLOWED_DEV_ORIGINS ||
    '',
  );
}

function mergeAllowedDevOrigins(existing, originUrls) {
  const hosts = [];
  for (const value of originUrls || []) {
    try {
      hosts.push(new URL(String(value)).hostname);
    } catch {
      // Invalid base URLs are rejected by their owning config before this helper.
    }
  }
  return parseOriginList([existing, ...hosts].filter(Boolean).join(','));
}

module.exports = {
  mergeAllowedDevOrigins,
  parseOriginList,
  resolveAllowedDevOrigins,
};
