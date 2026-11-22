import { appendFileSync } from 'node:fs';
import { parseCorsOriginAllowlist } from '../../supabase/functions/_shared/cors.mjs';

const allowedOriginKeys = {
  API_GATEWAY_CORS_ALLOW_ORIGINS: ['API_GATEWAY_CORS_ALLOW_ORIGINS'],
  LABEL_RENDERER_CORS_ALLOW_ORIGINS: ['LABEL_RENDERER_CORS_ALLOW_ORIGINS'],
  // Set each landing facade's primary key so legacy fallbacks cannot override this value.
  LANDING_CORS_ALLOW_ORIGINS: [
    'MARKETING_CORS_ALLOW_ORIGINS',
    'TENANT_SIGNUP_CORS_ALLOW_ORIGINS',
    'DRIVER_SIGNUP_CORS_ALLOW_ORIGINS',
  ],
  PUBLIC_TRACKING_CORS_ALLOW_ORIGINS: ['PUBLIC_TRACKING_CORS_ALLOW_ORIGINS'],
};

const lines = [];
const counts = [];
for (const [variable, keys] of Object.entries(allowedOriginKeys)) {
  const value = process.env[variable];
  if (!value) {
    console.error(`::error::Set the ${variable} environment variable for hosted function CORS.`);
    process.exit(1);
  }
  const { origins, invalid } = parseCorsOriginAllowlist(value);
  if (invalid.length || value.split(',').some(entry => !entry || /[\s*]/u.test(entry))) {
    console.error(`::error::${variable} must be a comma-separated list of exact non-loopback HTTPS origins without whitespace or wildcards.`);
    process.exit(1);
  }
  for (const key of keys) lines.push(`${key}=${[...origins].join(',')}\n`);
  counts.push(`${variable}: ${origins.size} origin(s)`);
}

appendFileSync(process.env.EDGE_SECRET_FILE, lines.join(''));
for (const count of counts) console.log(count);
