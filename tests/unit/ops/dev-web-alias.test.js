const { assignAndVerifyDevAlias } = require('../../../scripts/ops/vercel/validate-build');

const alias = ['console-dev', 'fixture', 'invalid'].join('.');
const preview = ['console-preview', 'vercel', 'app'].join('.');
const marker = '_next/static/dev-build-1-1.txt';
const env = {
  DEV_WEB_ORIGINS: [alias, alias.replace('console-dev', 'portal-dev'), alias.replace('console-dev', 'console')]
    .map(host => `https://${host}`).join(','),
  VERCEL_ORG_ID: 'team',
  VERCEL_PROJECT_ID: 'project',
  VERCEL_TOKEN: 'fixture',
  GITHUB_SHA: 'a'.repeat(40),
};

function verify(request, overrides) {
  return assignAndVerifyDevAlias('console', `https://${preview}`, marker, { ...env, ...overrides }, request);
}

function hostingResponse({ domainProject = env.VERCEL_PROJECT_ID, projectId = env.VERCEL_PROJECT_ID,
  target, body = `${env.GITHUB_SHA}\n`, status = 200 } = {}) {
  return jest.fn()
    .mockResolvedValueOnce(Response.json({ name: alias, projectId: domainProject, verified: true }))
    .mockResolvedValueOnce(Response.json({ id: 'deployment', url: preview, projectId, readyState: 'READY', target }))
    .mockResolvedValueOnce(Response.json({ alias }))
    .mockResolvedValueOnce(new Response(body, { status }));
}

test('assigns only the configured DEV alias and reads the expected marker without credentials', async () => {
  const request = hostingResponse();
  await verify(request);
  const [[domain], [deployment], [assignment, update], [markerUrl, read]] = request.mock.calls;
  expect(domain.pathname).toBe(`/v9/projects/project/domains/${alias}`);
  expect(deployment.pathname).toBe(`/v13/deployments/${preview}`);
  expect(assignment.pathname).toBe('/v2/deployments/deployment/aliases');
  expect(assignment.searchParams.get('teamId')).toBe(env.VERCEL_ORG_ID);
  expect(update.method).toBe('POST');
  expect(JSON.parse(update.body)).toEqual({ alias });
  expect(markerUrl.href).toBe(`https://${alias}/${marker}`);
  expect(read).toEqual({ redirect: 'error', signal: expect.any(AbortSignal) });
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
  for (const config of [{ body: 'older' }, { status: 302 }]) {
    await expect(verify(hostingResponse(config))).rejects.toThrow('DEV web alias did not serve the new build');
  }
});
