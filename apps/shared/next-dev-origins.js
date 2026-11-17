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

module.exports = {
  parseOriginList,
  resolveAllowedDevOrigins,
};
