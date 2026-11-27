// intake.arabic.test.tsx: the intake page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { IntakeModule } from '@/modules/integrations/intake';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/integrations-intake';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('IntakeModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/integrations/intake');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<IntakeModule />, { locale: 'ar', capabilities: ['all'] });

    const [title] = await screen.findAllByText(ar.integrationsIntake.intakeModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.integrationsIntake.intakeModule.webhookInboxDirectory);
    expect(findUntranslated(copy, ['Webhook'])).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<IntakeModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.integrationsIntake.intakeModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('integrationsIntake.intakeModule.titleAccent')).toBe('Inbound');
    expect(englishT('integrationsIntake.intakeModule.webhookInbox')).toBe('Webhook inbox');
    expect(lookup(ar, 'integrationsIntake.intakeModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
