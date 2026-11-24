const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { redactRuntimeOutput } = require('../../../scripts/ops/workspace/docker-runtime/redaction');

test('webhook replay failure envelope keeps diagnostics and removes sensitive values', () => {
  // Load only the sanitizer so the stress suite never opens a database connection.
  const source = readFileSync(require.resolve('../../integration/webhook-replay-stress.test.js'), 'utf8');
  const start = source.indexOf('function sanitizeFailureEnvelope(');
  const end = source.indexOf('function expectWebhookStatus(', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const sanitize = runInNewContext(`${source.slice(start, end)}\nsanitizeFailureEnvelope`, { redactRuntimeOutput });

  const fixture = (label) => createHash('sha256').update(label).digest('base64url');
  const jwtHeader = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const jwt = [jwtHeader, fixture('replay claims'), fixture('replay signature')].join('.');
  const key = ['sb', 'secret', fixture('replay API key')].join('_');
  const bearer = fixture('replay authorization');

  const envelope = sanitize({
    response: { status: 502 },
    correlationId: 'replay-fixture',
    body: {
      code: 'edge.rpc.intake_failed',
      error: `Authorization: Bearer ${bearer}\nToken ${jwt}\nKey ${key}`,
      details: {
        rpc_status: 503,
        rpc_body: { value: 'private payload' },
        rpc_message: 'private diagnostic',
      },
    },
  });

  expect(JSON.parse(JSON.stringify(envelope))).toStrictEqual({
    status: 502,
    code: 'edge.rpc.intake_failed',
    rpc_status: 503,
    message: 'Authorization: Bearer [redacted]\nToken [redacted-jwt]\nKey [redacted-supabase-key]',
    correlation: 'replay-fixture',
  });
});
