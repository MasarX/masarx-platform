// credentials.arabic.test.tsx: the credentials page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { CredentialsModule } from '@/modules/integrations/credentials';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/integrations-credentials';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('CredentialsModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/integrations/credentials');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<CredentialsModule />, { locale: 'ar', capabilities: ['all'] });

    const [title] = await screen.findAllByText(ar.integrationsCredentials.credentialsModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.integrationsCredentials.credentialsModule.providerCredentialVault);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<CredentialsModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.integrationsCredentials.credentialsModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('integrationsCredentials.credentialsModule.titlePlain')).toBe('credentials');
    expect(englishT('integrationsCredentials.credentialsModule.rotateCredential')).toBe('Rotate credential');
    expect(lookup(ar, 'integrationsCredentials.credentialsModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
