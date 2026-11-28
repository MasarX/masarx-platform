const { randomUUID } = require('node:crypto');
const { formatDockerFailure } = require('../../../scripts/edge/verify-label-renderer-preview.cjs');

test('reports the Docker exit status and classifies stderr without emitting input values', () => {
  const token = randomUUID();
  const host = `${randomUUID()}.invalid`;
  const mount = `/tmp/${randomUUID()}`;
  const stderr = [
    `Get "https://${host}/v2/": TLS handshake timeout`,
    `docker: Error response from daemon: invalid mount config: ${mount}`,
    `::error::Authorization: Bearer ${token}`,
  ].join('\r\n');

  expect(formatDockerFailure({ status: 125, stderr })).toBe(
    'exit_status=125 spawn_error=none stderr=["Registry or network error","Invalid container mount","redacted"]',
  );
});

test('reports at most the last 20 stderr lines', () => {
  const stderr = ['no space left on device', ...Array(20).fill('OCI runtime create failed'), ''].join('\n');

  expect(formatDockerFailure({ status: 125, stderr })).toBe(
    `exit_status=125 spawn_error=none stderr=${JSON.stringify(Array(20).fill('Container startup failed'))}`,
  );
});

test('reports a process timeout when Docker did not return an exit status', () => {
  const error = Object.assign(new Error(randomUUID()), { code: 'ETIMEDOUT' });

  expect(formatDockerFailure({ status: null, error })).toBe('exit_status=unavailable spawn_error=ETIMEDOUT stderr=[]');
});
