import { expect, it } from 'vitest';
import { resolveLegacyConsoleRoute } from './legacy-routes';
import { buildRouteBreadcrumbs } from './route-meta';

const home = { label: 'Dashboard', to: '/' };

it.each([
  ['', null, null],
  ['/', null, null],
  ['/app/', null, 'App'],
  ['/app///', null, 'App'],
  ['  /app//  ', null, '  '],
  ['//evil', null, 'Evil'],
  ['https://x', null, 'X'],
  ['/a b', null, 'A B'],
  ['/console///', '/', 'Console'],
] as const)('normalizes route input %j', (input, redirect, leaf) => {
  expect(resolveLegacyConsoleRoute(input)).toBe(redirect);
  expect(buildRouteBreadcrumbs(input)).toEqual(leaf === null ? [home] : [home, { label: leaf }]);
});

it('handles a long run of internal slashes in routes within the CPU budget', () => {
  const input = `/app${'/'.repeat(100_000)}x`;
  const start = process.cpuUsage();
  const redirect = resolveLegacyConsoleRoute(input);
  const breadcrumbs = buildRouteBreadcrumbs(input);
  const { user, system } = process.cpuUsage(start);

  expect(redirect).toBeNull();
  expect(breadcrumbs).toEqual([home, { label: 'X' }]);
  expect(user + system).toBeLessThan(250_000);
});
