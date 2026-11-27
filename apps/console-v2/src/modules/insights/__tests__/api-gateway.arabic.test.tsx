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

/** Runs the shared untranslated check on one filled template; `data` names the values the test supplied. */
function untranslatedIn(text: string, data: readonly string[]): string[] {
  const node = document.createElement('span');
  node.textContent = text;
  return findUntranslated(node, data);
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

    const [plain] = await screen.findAllByText(ar.insightsApiGateway.apiGatewayModule.titlePlain);
    expect(findUntranslated(plain)).toEqual([]);
    expect(plain.textContent).toContain(ar.insightsApiGateway.apiGatewayModule.titleAccent);
    const [eyebrow] = await screen.findAllByText(ar.insightsApiGateway.apiGatewayModule.externalIntake);
    expect(findUntranslated(eyebrow)).toEqual([]);
  });

  it('renders the view tabs and the KPI strip in Arabic', async () => {
    renderWithProviders(<ApiGatewayModule />, { locale: 'ar', capabilities: ['all'] });

    expect(findUntranslated(await screen.findByTestId('api-gateway-view-tabs'))).toEqual([]);
    expect(findUntranslated(await screen.findByTestId('api-gateway-kpi-strip'))).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<ApiGatewayModule />, { locale: 'ar', capabilities: ['shipments.read'] });
    expect(await screen.findByText(ar.insightsApiGateway.apiGatewayModule.apiGatewayPermissionIs)).toBeInTheDocument();
  });

  it.each([
    ['insightsApiGateway.apiGatewayModule.titlePlain', 'request intake'],
    ['insightsApiGateway.apiGatewayShipmentTestForm.sourceTokensAreSecret', 'Source tokens are secret and returned only on create/rotate. The selector verifies the source context; the pasted token is validated during send and then cleared from this form.'],
    ['insightsApiGateway.kpiStrip.rateLimitedResponses', '429 responses'],
    ['insightsApiGateway.filterBar.startLiveTail', 'Start live tail'],
    ['insightsApiGateway.routeScopeLabel.globalDefault', 'Global default'],
    ['insightsApiGateway.disabledReason.noRouteConfirmation', 'No route confirmation for this API request'],
  ])('keeps the English copy for %s and has Arabic', (key, english) => {
    expect(englishT(key)).toBe(english);
    expect(lookup(ar, key)).toMatch(/[؀-ۿ]/);
  });

  it.each([
    ['units.ms', { ms: '120' }, '120ms'],
    ['units.perMinute', { count: '60' }, '60/min'],
    ['units.bytes', { count: '512' }, '512 B'],
    ['apiGatewayModule.liveCallsCount', { count: '7' }, 'Live calls · 7'],
    ['kpiStrip.errorsCount', { count: '2' }, '2 errors'],
    ['kpiStrip.overSloLatencywarnMs', { latencyWarn: '900' }, 'over SLO 900ms'],
    ['latencyTab.gatewayOwnmsPct', { ownMs: '40', pct: '25' }, 'Gateway · 40ms (25%)'],
    ['latencyTab.providerTimeDownstreamPct', { downstream: '120', pct: '75' }, 'Provider time · 120ms (75%)'],
    ['apiGatewayShipmentTestForm.originalRouteNotVisible', { route: '/v1/orders' }, 'Original route not visible: /v1/orders'],
    ['adjustRateLimitForm.bucketOption', { source: 'Partner feed', limit: '60' }, 'Partner feed · 60/min'],
  ])('fills %s in English and has no English left in Arabic', (key, values, english) => {
    expect(fill(englishT(`insightsApiGateway.${key}`), values)).toBe(english);
    expect(untranslatedIn(fill(String(lookup(ar.insightsApiGateway, key)), values), Object.values(values))).toEqual([]);
  });

  it('keeps the KPI window label English and fills it in Arabic', () => {
    expect(fill(englishT('insightsApiGateway.kpiWindowLabel.lastHours'), { count: '1' })).toBe('last 1h');
    expect(fill(ar.insightsApiGateway.kpiWindowLabel.lastHours, { count: '1' })).toContain('1');
  });

  it('has Arabic for the outbound lifecycle drawer', () => {
    expect(englishT('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.gatewayRequest')).toBe('Gateway request');
    expect(lifecycleAr.insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.gatewayRequest).toMatch(/[؀-ۿ]/);
    expect(englishT('insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.pending')).toBe('pending');
    expect(untranslatedIn(lifecycleAr.insightsApiGatewayLifecycle.apiGatewayOutboundLifecycleBody.pending, [])).toEqual([]);
  });
});
