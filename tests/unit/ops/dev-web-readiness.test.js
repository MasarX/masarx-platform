jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }));

const { execFileSync } = require('node:child_process');
const { verifyDevSweepTargets } = require('../../../scripts/ops/vercel/validate-build');

const sha = 'a'.repeat(40);
const marker = '_next/static/dev-build-1-1.txt';
const origin = surface => `https://${[surface, 'fixture', 'invalid'].join('.')}`;
const consoleOrigin = origin('console-dev');
const portalOrigin = origin('portal-dev');
const origins = [origin('portal'), portalOrigin, origin('console'), consoleOrigin].join(',');
const light = ':root{--ui-muted:71  85\n105}';
const dark = ':root[data-theme=dark]{--ui-muted:148 163 184}';

function fixtures({ css = light, markerStatus = 200, markerSha = sha } = {}) {
  return jest.fn(async url => {
    if (url.pathname === `/${marker}`) {
      return url.origin === consoleOrigin
        ? new Response(`${markerSha}\n`, { status: markerStatus })
        : new Response(`${sha}\n`);
    }
    if (url.pathname === '/signin') {
      return new Response(`<link href='/theme.css' rel='stylesheet'>
        <link rel="preload" as="style" href="/unused.css">
        <link rel="stylesheet" href="${origin('external')}/ignored.css">`);
    }
    if (url.pathname === '/theme.css') return new Response(`${css}\n${dark}`);
    throw new Error('Unexpected request');
  });
}

beforeEach(() => execFileSync.mockReturnValue(':root { --ui-muted: 71 85 105; }'));

test('returns named DEV sweep targets after comparing their linked light token with the exact source SHA', async () => {
  const request = fixtures();
  await expect(verifyDevSweepTargets(sha, marker, origins, request)).resolves.toEqual({
    console: consoleOrigin, portal: portalOrigin, sha,
  });
  expect(execFileSync).toHaveBeenCalledWith('git', ['show', `${sha}:packages/ui/src/styles.css`], expect.any(Object));
  for (const target of [consoleOrigin, portalOrigin]) {
    expect(request.mock.calls.filter(([url]) => url.origin === target).map(([url]) => url.pathname))
      .toEqual([`/${marker}`, '/signin', '/theme.css']);
  }
  expect(request).toHaveBeenCalledTimes(6);
});

test.each([
  ['is missing', { markerStatus: 404 }],
  ['belongs to another commit', { markerSha: 'b'.repeat(40) }],
])('refuses sweep targets when a marker %s', async (_label, options) => {
  const request = fixtures(options);
  await expect(verifyDevSweepTargets(sha, marker, origins, request)).rejects.toThrow('expected build marker');
  expect(request.mock.calls.filter(([url]) => url.origin === consoleOrigin).map(([url]) => url.pathname))
    .toEqual([`/${marker}`]);
});

test.each([
  ['stale', ':root{--ui-muted:100 116 139}', 'does not match source'],
  ['missing', '', 'missing or conflicting'],
  ['conflicting', `${light}\n:root{--ui-muted:100 116 139}`, 'missing or conflicting'],
])('refuses a %s light token even when the build marker matches', async (_label, css, error) => {
  await expect(verifyDevSweepTargets(sha, marker, origins, fixtures({ css }))).rejects.toThrow(error);
});

test('refuses ambiguous DEV targets before making requests', async () => {
  const request = jest.fn();
  const ambiguous = consoleOrigin.replace('fixture', 'other');
  await expect(verifyDevSweepTargets(sha, marker, `${origins},${ambiguous}`, request))
    .rejects.toThrow('Invalid DEV web alias configuration');
  expect(request).not.toHaveBeenCalled();
});
