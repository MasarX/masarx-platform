// api-gateway.arabic.test.tsx: the API request intake page renders its own copy in Arabic (issue #302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { ApiGatewayModule } from '@/modules/insights/api-gateway';
import { englishT, fill } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/insights-api-gateway';
import lifecycleAr from '@/lib/seed-raw/i18n/areas/ar/insights-api-gateway-lifecycle';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('ApiGatewayModule in Arabic', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubEnv('VITE_USE_SEED', 'true');
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders the page header in Arabic', async () => {
    renderWithProviders(<ApiGatewayModule />, { locale: 'ar', capabilities: ['all'] });

    const [plain] = await screen.findAllByText(ar.insightsApiGateway.apiGatewayModule.requestIntake);
    expect(findUntranslated(plain)).toEqual([]);
    const [eyebrow] = await screen.findAllByText(ar.insightsApiGateway.apiGatewayModule.externalIntake);
    expect(findUntranslated(eyebrow)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<ApiGatewayModule />, { locale: 'ar', capabilities: ['shipments.read'] });
    expect(await screen.findByText(ar.insightsApiGateway.apiGatewayModule.apiGatewayPermissionIs)).toBeInTheDocument();
  });

  it.each([
    ['insightsApiGateway.apiGatewayModule.requestIntake', 'request intake'],
    ['insightsApiGateway.filterBar.startLiveTail', 'Start live tail'],
    ['insightsApiGateway.routeScopeLabel.globalDefault', 'Global default'],
    ['insightsApiGateway.disabledReason.noRouteConfirmation', 'No route confirmation for this API request'],
  ])('keeps the English copy for %s and has Arabic', (key, english) => {
    expect(englishT(key)).toBe(english);
    expect(lookup(ar, key)).toMatch(/[؀-ۿ]/);
  });

  it('keeps the KPI window label English and fills it in Arabic', () => {
    expect(fill(englishT('insightsApiGateway.kpiWindowLabel.lastHours'), { count: '1' })).toBe('last 1h');
    expect(fill(ar.insightsApiGateway.kpiWindowLabel.lastHours, { count: '1' })).toContain('1');
  });

  it('has Arabic for the outbound lifecycle drawer', () => {
    expect(englishT('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.gatewayRequest')).toBe('Gateway request');
    expect(lifecycleAr.insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.gatewayRequest).toMatch(/[؀-ۿ]/);
  });
});
