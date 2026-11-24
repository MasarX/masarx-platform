// webhook-tester.arabic.test.tsx: the webhook tester renders its own copy in Arabic; plugin, source and mapping names stay as data.
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { WebhookTesterModule } from '@/modules/integrations/webhook-tester';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/integrations-webhook-tester';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('WebhookTesterModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/integrations/webhook-tester');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<WebhookTesterModule />, { locale: 'ar', capabilities: ['all'] });

    const chip = await screen.findByText(ar.integrationsWebhookTester.webhookTesterModule.webhookReceiverMappingProfiles);
    expect(findUntranslated(chip, ['Webhook'])).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<WebhookTesterModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.integrationsWebhookTester.webhookTesterModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('integrationsWebhookTester.webhookTesterModule.receiverRequest')).toBe('Receiver request');
    expect(englishT('integrationsWebhookTester.webhookTesterModule.stepOther')).toBe('({length} steps)');
    expect(lookup(ar, 'integrationsWebhookTester.webhookTesterModule.receiverRequest')).toBe('طلب المستقبِل');
  });
});
