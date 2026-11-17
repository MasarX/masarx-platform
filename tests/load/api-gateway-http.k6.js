// HTTP-level API gateway load test for authenticated preview/stg ingress.
// Requires API_GATEWAY_BASE_URL and API_GATEWAY_HTTP_TOKEN.

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: Number(__ENV.API_GATEWAY_HTTP_VUS || 5),
  duration: __ENV.API_GATEWAY_HTTP_DURATION || '30s',
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<1500'],
  },
};

const BASE_URL = (__ENV.API_GATEWAY_BASE_URL || '').replace(/\/$/, '');
const TOKEN = __ENV.API_GATEWAY_HTTP_TOKEN || '';
const PATH = __ENV.API_GATEWAY_HTTP_PATH || '/api/ship/request/by-email';
const METHOD = String(__ENV.API_GATEWAY_HTTP_METHOD || 'POST').trim().toUpperCase();

if (!BASE_URL || !TOKEN) {
  throw new Error('api-gateway-http requires API_GATEWAY_BASE_URL and API_GATEWAY_HTTP_TOKEN');
}

function buildBody() {
  return JSON.stringify({
    email: 'loadtest@example.com',
    password: 'redacted',
    pkgUnitType: 'METRIC',
    pkg: {
      cod: 0,
      notes: 'API gateway load test',
      invoiceNumber: `LOAD-${__VU}-${__ITER}-${Date.now()}`,
      senderName: 'Load Sender',
      receiverName: 'Load Receiver',
      senderPhone: '+12025550123',
      receiverPhone: '+12025550123',
      quantity: 1,
      serviceType: 'STANDARD',
      shipmentType: 'COD',
      email: 'loadtest@example.com',
      password: 'redacted',
    },
    destinationAddress: {
      addressLine1: 'Load Destination',
      cityId: 1,
      villageId: 38,
      regionId: 1,
    },
    originAddress: {
      addressLine1: 'Load Origin',
      addressLine2: '',
      cityId: 5,
      regionId: 1,
      villageId: 180,
    },
  });
}

export default function () {
  const headers = {
    'content-type': 'application/json',
    'x-webhook-token': TOKEN,
  };

  const url = `${BASE_URL}${PATH.startsWith('/') ? PATH : `/${PATH}`}`;
  const body = ['GET', 'HEAD', 'DELETE'].includes(METHOD) ? null : buildBody();
  const res = http.request(METHOD, url, body, { headers });

  check(res, {
    'status is 2xx/202': (r) => [200, 201, 202].includes(r.status),
  });
  sleep(0.05);
}
