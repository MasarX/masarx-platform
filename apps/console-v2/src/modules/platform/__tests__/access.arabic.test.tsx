// access.arabic.test.tsx: the access page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { AccessModule } from '@/modules/platform/access';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/platform-access';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('AccessModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/platform/access');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<AccessModule />, { locale: 'ar', capabilities: ['access_policy.read'] });

    const [title] = await screen.findAllByText(ar.platformAccess.accessModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.platformAccess.accessModule.assignments);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<AccessModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.platformAccess.accessModule.accessPolicyResolutionRequires)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('platformAccess.accessModule.titlePlain')).toBe('control');
    expect(englishT('platformAccess.accessModule.grantRevokeRequire')).toBe('Grant / Revoke require');
    expect(lookup(ar, 'platformAccess.accessModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
