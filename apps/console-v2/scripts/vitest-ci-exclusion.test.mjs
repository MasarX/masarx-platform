// @vitest-environment node

import { expect, it } from 'vitest';
import { consoleV2TestExclusions } from '../vitest.config.ts';

const capabilityLint = 'scripts/lint-capabilities.test.mjs';

it('enforces the capability lint CI exclusion through December 4 UTC', () => {
  const lastActive = new Date('2026-12-04T23:59:59.999Z');
  const firstExpired = new Date('2026-12-05T00:00:00.000Z');

  expect(consoleV2TestExclusions(true, lastActive)).toContain(capabilityLint);
  expect(() => consoleV2TestExclusions(true, firstExpired)).toThrow(
    'scripts/lint-capabilities.test.mjs expired after 2026-12-04 UTC (MasarX lead)',
  );
  expect(consoleV2TestExclusions(false, firstExpired)).not.toContain(capabilityLint);
});
