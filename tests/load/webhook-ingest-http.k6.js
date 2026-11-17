// HTTP-level webhook ingest load test (feature toggled by scenario selection)
// Requires SUPABASE_URL and either SUPABASE_ANON_KEY (for platform auth) or WEBHOOK_HTTP_TOKEN for x-webhook-token.

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: Number(__ENV.WEBHOOK_HTTP_VUS || 5),
  duration: __ENV.WEBHOOK_HTTP_DURATION || '30s',
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<1500']
  }
};

const SUPABASE_URL = __ENV.SUPABASE_URL || '';
const ANON = __ENV.SUPABASE_ANON_KEY || '';
const TOKEN = __ENV.WEBHOOK_HTTP_TOKEN || '';

if (!SUPABASE_URL || (!ANON && !TOKEN)) {
  throw new Error('webhook-ingest-http requires SUPABASE_URL and WEBHOOK_HTTP_TOKEN or SUPABASE_ANON_KEY');
}

export default function () {
  const payload = {
    event: { id: `evt-${__VU}-${__ITER}-${Date.now()}`, type: 'shipment.created' },
    shipment: { tracking_number: `TRK-${Math.random().toString(36).slice(2,10)}` }
  };

  const headers = {
    'content-type': 'application/json',
  };
  if (ANON) headers['authorization'] = `Bearer ${ANON}`;
  if (TOKEN) headers['x-webhook-token'] = TOKEN;
  if (ANON) headers['apikey'] = ANON;

  const res = http.post(`${SUPABASE_URL.replace(/\/$/,'')}/functions/v1/webhook-receiver`, JSON.stringify(payload), { headers });
  check(res, {
    'status is 2xx/202': (r) => [200, 201, 202].includes(r.status)
  });
  sleep(0.05);
}

