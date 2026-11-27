// health.arabic.test.tsx: the health page renders its own copy in Arabic (issue #302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { HealthModule } from '@/modules/integrations/health';
import * as apiMod from '@/lib/api';
import { englishT, fill } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/integrations-health';

const AR = ar.integrationsHealth.healthModule;
const PROVIDER = 'Examplecourier Returns';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('HealthModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/integrations/health');
  });
  afterEach(() => {
    vi.restoreAllMocks();
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
    expect(lookup(ar, 'integrationsHealth.healthModule.titleAccent')).toMatch(/[؀-ۿ]/);
  });

  it('titles the circuit breaker drawer in Arabic', async () => {
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource) => {
      if (resource === 'circuit_breaker_dashboard') {
        const rows = [
          {
            provider_id: 'prv_examplecourier_rto',
            provider_name: PROVIDER,
            operation_name: 'shipment_status_query',
            state: 'half_open',
            failure_rate: 0.16,
            updated_at: '2026-05-24T00:40:00Z',
            half_open_test_at: '2026-05-24T00:50:00Z',
            reopen_count: 2,
            manual_intervention_required: true,
            last_health_status: 'degraded',
            last_health_error: null,
            last_health_at: '2026-05-24T00:45:00Z',
          },
        ];
        return { rows, total: rows.length, count: rows.length } as never;
      }
      return { rows: [], total: 0, count: 0 } as never;
    });
    renderWithProviders(<HealthModule />, { locale: 'ar', capabilities: ['integrations.read'] });

    fireEvent.click(await screen.findByText('shipment_status_query'));
    await screen.findByTestId('circuit-breaker-drawer');

    const title = document.querySelector('.drawer__title') as HTMLElement;
    expect(title).toHaveTextContent(fill(AR.circuitBreakerFor, { provider: PROVIDER }));
    expect(findUntranslated(title, ['Examplecourier', 'Returns'])).toEqual([]);
  });

  it('keeps one whole drawer title per state in both languages', () => {
    const box = document.createElement('div');
    box.textContent = [
      fill(AR.providerHealthFor, { provider: '' }),
      fill(AR.circuitBreakerFor, { provider: '' }),
      AR.providerHealth,
      AR.circuitBreaker,
    ].join(' ');
    expect(findUntranslated(box)).toEqual([]);
    expect(fill(englishT('integrationsHealth.healthModule.providerHealthFor'), { provider: PROVIDER })).toBe(`Provider health - ${PROVIDER}`);
    expect(fill(englishT('integrationsHealth.healthModule.circuitBreakerFor'), { provider: PROVIDER })).toBe(`Circuit breaker - ${PROVIDER}`);
  });
});
