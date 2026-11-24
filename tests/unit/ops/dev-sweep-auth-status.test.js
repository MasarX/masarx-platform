const { randomBytes, X509Certificate } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { buildSupabaseProjectUrl } = require('../../../scripts/ops/workspace/preview-project');

test('sweep reports only the Auth config HTTP status and stops before provisioning', async () => {
  const { provisionSweep } = await import('../../../scripts/deploy/dev-sweep-users.mjs');
  const projectRef = 'a'.repeat(20);
  const certificate = new X509Certificate(readFileSync(join(__dirname, '../../../config/dev/sweep-recipient.crt')));
  const response = new Response('private provider response', { status: 403 });
  const request = jest.spyOn(global, 'fetch').mockResolvedValue(response);
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(provisionSweep({
      GITHUB_ACTIONS: 'true', DEPLOY_ENV: 'dev', GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'MasarX/masarx-platform',
      SUPABASE_PROJECT_REF: projectRef, NEXT_PUBLIC_SUPABASE_URL: buildSupabaseProjectUrl(projectRef),
      SUPABASE_ACCESS_TOKEN: randomBytes(24).toString('hex'),
      SWEEP_RECIPIENT_SHA256: certificate.fingerprint256, RUNNER_TEMP: tmpdir(),
    })).rejects.toBeDefined();
    expect(request).toHaveBeenCalledTimes(1);
    expect(response.bodyUsed).toBe(false);
    expect(log.mock.calls.every(([line]) => line.startsWith('::add-mask::'))).toBe(true);
    expect(error.mock.calls).toEqual([['auth_config_http_status=403']]);
  } finally {
    request.mockRestore();
    log.mockRestore();
    error.mockRestore();
  }
});
