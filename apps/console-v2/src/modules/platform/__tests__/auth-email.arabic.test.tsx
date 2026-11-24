// auth-email.arabic.test.tsx: the auth-email page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { AuthEmailModule } from '@/modules/platform/auth-email';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/platform-auth-email';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('AuthEmailModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/platform/auth-email');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<AuthEmailModule />, { locale: 'ar', capabilities: ['settings.read'] });

    const [title] = await screen.findAllByText(ar.platformAuthEmail.authEmailModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.platformAuthEmail.authEmailModule.managedByPlatformRelease);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<AuthEmailModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.platformAuthEmail.authEmailModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('platformAuthEmail.authEmailModule.titlePlain')).toBe('URL policy');
    expect(englishT('platformAuthEmail.authEmailModule.hostedCallbackUrlsAre')).toBe('Hosted callback URLs are governed by platform release controls. This page is read-only; changes are reviewed outside the console before promotion.');
    expect(lookup(ar, 'platformAuthEmail.authEmailModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
