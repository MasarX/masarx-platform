const { assignAndVerifyDevAlias } = require('../../../scripts/ops/vercel/validate-build');

const alias = ['console-dev', 'fixture', 'invalid'].join('.');
const preview = ['console-preview', 'vercel', 'app'].join('.');
const githubApi = `https://${['api', 'fixture', 'invalid'].join('.')}`;
const marker = '_next/static/dev-build-1-1.txt';
const env = {
  DEV_WEB_ORIGINS: [alias, alias.replace('console-dev', 'portal-dev'), alias.replace('console-dev', 'console')]
    .map(host => `https://${host}`).join(','),
  VERCEL_ORG_ID: 'team',
  VERCEL_PROJECT_ID: 'project',
  VERCEL_TOKEN: 'fixture',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_API_URL: githubApi,
  GITHUB_REPOSITORY: 'owner/repository',
  GH_TOKEN: 'github-fixture',
};

function verify(request, overrides) {
  return assignAndVerifyDevAlias('console', `https://${preview}`, marker, { ...env, ...overrides }, request);
}

function hostingResponse({ domainProject = env.VERCEL_PROJECT_ID, projectId = env.VERCEL_PROJECT_ID,
  target, deployedSha = env.GITHUB_SHA, githubResult, body = `${env.GITHUB_SHA}\n`, status = 200 } = {}) {
  const request = jest.fn()
    .mockResolvedValueOnce(Response.json({ name: alias, projectId: domainProject, verified: true }))
    .mockResolvedValueOnce(Response.json({ id: 'deployment', url: preview, projectId, readyState: 'READY', target,
      meta: { devCommitSha: env.GITHUB_SHA } }))
    .mockResolvedValueOnce(Response.json({ alias, projectId, deployment: { meta: { devCommitSha: deployedSha } } }));
  if (githubResult) request.mockResolvedValueOnce(Response.json(githubResult));
  return request
    .mockResolvedValueOnce(Response.json({ alias }))
    .mockImplementation(async () => new Response(body, { status }));
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('assigns only the configured DEV alias and reads the expected marker without credentials', async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const request = hostingResponse();
  await verify(request);
  const [[domain], [deployment], [currentAlias], [assignment, update], [markerUrl, read]] = request.mock.calls;
  expect(domain.pathname).toBe(`/v9/projects/project/domains/${alias}`);
  expect(deployment.pathname).toBe(`/v13/deployments/${preview}`);
  expect(currentAlias.pathname).toBe(`/v4/aliases/${alias}`);
  expect(assignment.pathname).toBe('/v2/deployments/deployment/aliases');
  expect(assignment.searchParams.get('teamId')).toBe(env.VERCEL_ORG_ID);
  expect(update.method).toBe('POST');
  expect(JSON.parse(update.body)).toEqual({ alias });
  expect(markerUrl.href).toBe(`https://${alias}/${marker}`);
  expect(read).toEqual({ redirect: 'manual', cache: 'no-store', signal: expect.any(AbortSignal) });
});

test('fails before alias assignment for ambiguous aliases, production deployments and other projects', async () => {
  const request = jest.fn();
  await expect(verify(request, { DEV_WEB_ORIGINS: `${env.DEV_WEB_ORIGINS},https://${alias.replace('fixture', 'other')}` }))
    .rejects.toThrow('Invalid DEV web alias configuration');
  expect(request).not.toHaveBeenCalled();
  const wrongDomain = hostingResponse({ domainProject: 'other' });
  await expect(verify(wrongDomain)).rejects.toThrow('DEV web domain binding failed');
  expect(wrongDomain).toHaveBeenCalledTimes(1);
  for (const config of [{ target: 'production' }, { projectId: 'other' }]) {
    const request = hostingResponse(config);
    await expect(verify(request)).rejects.toThrow('DEV web deployment binding failed');
    expect(request).toHaveBeenCalledTimes(2);
  }
});

test('fails a DEV deployment when the alias returns stale content or redirects', async () => {
  jest.useFakeTimers();
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  for (const config of [{ body: 'older' }, { status: 302 }]) {
    log.mockClear();
    const request = hostingResponse(config);
    const verification = expect(verify(request)).rejects.toThrow('DEV web alias did not serve the new build within 120 seconds');
    await jest.advanceTimersByTimeAsync(120_000);
    await verification;
    expect(log.mock.calls).toEqual(Array.from({ length: 24 }, (_, i) => [
      `DEV web alias probe attempt=${i + 1} status=${config.status ?? 200}`,
    ]));
    expect(request).toHaveBeenCalledTimes(28);
  }
});

test('waits for the anonymous DEV marker after a transport error and a missing marker', async () => {
  jest.useFakeTimers();
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const request = hostingResponse();
  request.mockImplementation(async () => {
    if (request.mock.calls.length === 5) throw new Error(`Request to ${alias} failed`);
    if (request.mock.calls.length === 6) return new Response('provider response', { status: 404 });
    return new Response(`${env.GITHUB_SHA}\n`);
  });
  const verification = expect(verify(request)).resolves.toBe(true);
  await jest.advanceTimersByTimeAsync(10_000);
  await verification;
  expect(log.mock.calls).toEqual([
    ['DEV web alias probe attempt=1 status=none'],
    ['DEV web alias probe attempt=2 status=404'],
    ['DEV web alias probe attempt=3 status=200'],
  ]);
});

test('skips a stale run before writing the stable DEV alias', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const deployedSha = 'b'.repeat(40);
  const request = hostingResponse({ deployedSha, githubResult: { status: 'behind' } });
  await expect(verify(request)).resolves.toBe(false);
  expect(request).toHaveBeenCalledTimes(4);
  expect(request.mock.calls[3][0].href).toBe(`${githubApi}/repos/${env.GITHUB_REPOSITORY}/compare/${deployedSha}...${env.GITHUB_SHA}`);
  expect(request.mock.calls.every(([, options]) => options.method !== 'POST')).toBe(true);
  expect(log.mock.calls).toEqual([['Skipped stable DEV alias assignment: a newer commit is already deployed']]);
});

test('moves the stable DEV alias forward from an earlier deployed commit', async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const request = hostingResponse({ deployedSha: 'b'.repeat(40), githubResult: { status: 'ahead' } });
  await expect(verify(request)).resolves.toBe(true);
  expect(request.mock.calls[4][1].method).toBe('POST');
});

test('refuses to write the stable DEV alias when commit ancestry cannot be established', async () => {
  const request = hostingResponse({ deployedSha: 'b'.repeat(40), githubResult: { status: 'diverged' } });
  await expect(verify(request)).rejects.toThrow('Could not verify DEV web deployment commit order');
  expect(request.mock.calls.every(([, options]) => options.method !== 'POST')).toBe(true);
});

test('allows only the main tip to assign a legacy DEV alias without commit metadata', async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  for (const sha of [env.GITHUB_SHA, 'b'.repeat(40)]) {
    const request = hostingResponse({ deployedSha: null, githubResult: { object: { sha } } });
    const atTip = sha === env.GITHUB_SHA;
    await expect(verify(request)).resolves.toBe(atTip);
    expect(request.mock.calls[3][0].pathname).toBe(`/repos/${env.GITHUB_REPOSITORY}/git/ref/heads/main`);
    expect(request.mock.calls.some(([, options]) => options.method === 'POST')).toBe(atTip);
  }
});
