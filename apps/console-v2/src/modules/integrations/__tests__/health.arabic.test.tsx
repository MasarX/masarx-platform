// health.arabic.test.tsx: the health page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { HealthModule } from '@/modules/integrations/health';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/integrations-health';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('HealthModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/integrations/health');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<HealthModule />, { locale: 'ar', capabilities: ['all'] });

    const [title] = await screen.findAllByText(ar.integrationsHealth.healthModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.integrationsHealth.healthModule.integrations);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<HealthModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.integrationsHealth.healthModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('integrationsHealth.healthModule.titlePlain')).toBe('health');
    expect(englishT('integrationsHealth.healthModule.refreshTelemetry')).toBe('Refresh telemetry');
    expect(lookup(ar, 'integrationsHealth.healthModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
