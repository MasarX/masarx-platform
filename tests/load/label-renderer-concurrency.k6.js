import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';

const origin = String(__ENV.SUPABASE_URL || '').trim().replace(/\/$/, '');
const token = String(__ENV.LABEL_RENDERER_DB_JWT || '').trim();
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const fixture = JSON.parse(__ENV.LABEL_RENDERER_PAYLOAD_JSON || 'null');
const jobIds = fixture?.job_ids;

if (!/^https?:\/\/[^/?#@]+$/i.test(origin) || !token) {
  throw new Error('Set SUPABASE_URL and LABEL_RENDERER_DB_JWT for the label renderer test environment.');
}
if (!uuid.test(fixture?.organization_id || '') || !Array.isArray(jobIds) || jobIds.length === 0 ||
    jobIds.some((id) => typeof id !== 'string' || !uuid.test(id)) ||
    new Set(jobIds.map((id) => id.toLowerCase())).size !== jobIds.length) {
  throw new Error('Set LABEL_RENDERER_PAYLOAD_JSON with a synthetic organization and distinct seeded job ids.');
}

function positiveNumber(name, fallback) {
  const value = Number(__ENV[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

const vus = positiveNumber('LABEL_RENDERER_HTTP_VUS', 5);
const errorRate = positiveNumber('LABEL_RENDERER_ERROR_RATE_MAX', 0.02);
if (!Number.isInteger(vus) || errorRate >= 1) {
  throw new Error('Set an integer VU count and an error rate below one.');
}

export const options = {
  scenarios: {
    seeded_label_jobs: {
      executor: 'shared-iterations',
      vus: Math.min(vus, jobIds.length),
      iterations: jobIds.length,
      maxDuration: __ENV.LABEL_RENDERER_MAX_DURATION || '5m',
    },
  },
  thresholds: {
    checks: [`rate>${1 - errorRate}`],
    http_req_failed: [`rate<${errorRate}`],
    http_req_duration: [
      `p(95)<${positiveNumber('LABEL_RENDERER_HTTP_P95_MS', 5000)}`,
      `p(99)<${positiveNumber('LABEL_RENDERER_HTTP_P99_MS', 12000)}`,
    ],
  },
};

export default function () {
  const jobId = jobIds[exec.scenario.iterationInTest];
  if (!jobId) throw new Error('The scenario has more iterations than seeded jobs.');

  const response = http.post(`${origin}/functions/v1/label-renderer`, JSON.stringify({
    organization_id: fixture.organization_id,
    job_ids: [jobId],
    max_jobs: 1,
    job_concurrency: 1,
  }), {
    redirects: 0,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });

  let status;
  if (response.status === 200) {
    try {
      status = response.json('status');
    } catch {
      status = null;
    }
  }
  check(response, {
    'renderer accepted the seeded job': () => response.status === 202 || (response.status === 200 && status === 'ok'),
  });
}
