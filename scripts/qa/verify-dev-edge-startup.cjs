'use strict';

const assert = require('node:assert/strict');
const { functionsForDeploy } = require('../edge/functions-registry');
const { functions } = require('../../config/edge/functions.json');

// OPTIONS stops in the handlers before request processing. A few handlers reject it or return a no-op status.
const expectedStatus = {
  'api-caller': [405],
  'outbound-wake': [202],
  'webhook-receiver': [403],
  'label-renderer': [204],
  'label-designer-assets': [204],
  'organization-profile': [204],
  'ui-resource-download': [204],
  'metrics-echo-test': [403, 404],
  'outbound-probe-ack': [200],
  'api-gateway': [403],
  'marketing-lead-intake': [403],
  'driver-signup-intake': [403],
  'driver-application-documents': [403],
  'driver-application-status': [403],
  'marketplace-participant-review': [405],
  'public-shipment-tracking': [403],
  'resource-import-studio': [204],
  'tenant-signup-intake': [403],
  'tenant-signup-review': [204],
  'fieldops-reassignment-request': [204],
  'contactless-pod-intake': [403],
  'tenant-signup-console-request': [204],
  'tenant-user-invite': [204],
  'integration-plugin-studio': [204],
};

const executionId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

async function verifyStartup(projectRef, anonKey, probe = fetch) {
  assert(/^[a-z]{20}$/.test(projectRef), 'DEV project reference is missing or invalid');
  const jwt = typeof anonKey === 'string' && anonKey.match(/^([\w-]+)\.([\w-]+)\.([\w-]+)$/);
  let claims;
  try {
    if (jwt) claims = JSON.parse(Buffer.from(jwt[2], 'base64url').toString('utf8'));
  } catch {
    // Report only the configuration error below.
  }
  assert(claims?.role === 'anon' && claims.ref === projectRef, 'A DEV legacy anon JWT is required');

  const entries = functionsForDeploy(functions, 'dev');
  assert.deepEqual(entries.map(entry => entry.name).sort(), Object.keys(expectedStatus).sort(),
    'Define a read-only startup response for each enabled DEV function');

  const results = [];
  for (let i = 0; i < entries.length; i += 4) {
    const batch = await Promise.all(entries.slice(i, i + 4).map(async ({ name, auth_mode }) => {
      try {
        const response = await probe(`https://${projectRef}.supabase.co/functions/v1/${name}`, {
          method: 'OPTIONS',
          headers: auth_mode === 'supabase_jwt' ? { authorization: `Bearer ${anonKey}` } : {},
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        });
        const executed = executionId.test(response.headers.get('x-deno-execution-id') ?? '');
        const passed = executed && !response.headers.has('sb-error-code') && expectedStatus[name].includes(response.status);
        await response.body?.cancel();
        return { name, status: response.status, executed, passed };
      } catch {
        return { name, status: 'unavailable', executed: false, passed: false };
      }
    }));
    results.push(...batch);
  }
  return results;
}

if (require.main === module) {
  verifyStartup(process.env.SUPABASE_PROJECT_REF, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).then(results => {
    for (const { name, status, executed, passed } of results) {
      console.log(`${name} status=${status} runtime=${executed ? 'present' : 'unavailable'} outcome=${passed ? 'PASS' : 'FAIL'}`);
    }
    if (results.some(result => !result.passed)) process.exitCode = 1;
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { verifyStartup };
