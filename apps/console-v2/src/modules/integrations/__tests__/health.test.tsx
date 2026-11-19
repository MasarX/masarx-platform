import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { HealthModule } from '@/modules/integrations/health';
import * as apiMod from '@/lib/api';

const healthRows = [
  {
    provider_id: 'prv_examplecourier_rto',
    provider_name: 'Examplecourier Returns',
    status: 'degraded',
    success_rate_24h: 0.84,
    avg_latency_ms: 1840,
    error_rate_24h: 0.16,
    error_message: 'Gateway timeout',
    correlation_id: 'corr-health-1',
    decision_log_id: 'dec-health-1',
    created_at: '2026-05-24T00:45:00Z',
  },
];

const breakerRows = [
  {
    provider_id: 'prv_examplecourier_rto',
    provider_name: 'Examplecourier Returns',
    operation_name: 'shipment_status_query',
    state: 'half_open',
    failure_rate: 0.16,
    updated_at: '2026-05-24T00:40:00Z',
    half_open_test_at: '2026-05-24T00:50:00Z',
    reopen_count: 2,
    manual_intervention_required: true,
    last_health_status: 'degraded',
    last_health_error: 'Gateway timeout',
    last_health_at: '2026-05-24T00:45:00Z',
  },
];

type MockHealthRow = Omit<(typeof healthRows)[number], 'status' | 'error_message'> & {
  status: string;
  error_message: string | null;
};

type MockBreakerRow = Omit<(typeof breakerRows)[number], 'state' | 'last_health_status' | 'last_health_error' | 'half_open_test_at'> & {
  state: string;
  last_health_status: string;
  last_health_error: string | null;
  half_open_test_at: string | null;
};

interface ProviderHealthReadSource {
  healthRows: MockHealthRow[];
  breakerRows: MockBreakerRow[];
}

afterEach(() => {
  vi.restoreAllMocks();
});

function mockProviderHealthReads(
  source: ProviderHealthReadSource = {
    healthRows: healthRows as MockHealthRow[],
    breakerRows: breakerRows as MockBreakerRow[],
  },
) {
  return vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource) => {
    if (resource === 'provider_health_latest') {
      return { rows: source.healthRows, total: source.healthRows.length, count: source.healthRows.length } as never;
    }
    if (resource === 'circuit_breaker_dashboard') {
      return { rows: source.breakerRows, total: source.breakerRows.length, count: source.breakerRows.length } as never;
    }
    return { rows: [], total: 0, count: 0 } as never;
  });
}

describe('HealthModule', () => {
  it('shows a denied state without issuing protected provider health reads', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');

    renderWithProviders(<HealthModule />, { capabilities: [] });

    expect(await screen.findByText(/You do not have permission to view provider health/i)).toBeInTheDocument();
    await waitFor(() => {
      const resources = listSpy.mock.calls.map(([resource]) => resource);
      expect(resources).not.toContain('provider_health_latest');
      expect(resources).not.toContain('circuit_breaker_dashboard');
    });
  });

  it('renders backend provider health rows with operator context drawers', async () => {
    mockProviderHealthReads();

    renderWithProviders(<HealthModule />, { capabilities: ['integrations.read'] });

    const healthRow = await screen.findByRole('row', {
      name: /Open provider_health Examplecourier Returns/i,
    });
    fireEvent.click(healthRow);

    const drawer = await screen.findByTestId('provider-health-drawer');
    expect(within(drawer).getByText('Latest provider signal')).toBeInTheDocument();
    expect(within(drawer).getAllByText('Gateway timeout')).toHaveLength(2);
    expect(within(drawer).getByText('shipment_status_query')).toBeInTheDocument();
    expect(within(drawer).getByText('Required')).toBeInTheDocument();
    expect(within(drawer).getByText('corr-health-1')).toBeInTheDocument();
  });

  it('refreshes provider health, breaker reads, and the open drawer without leaving the page', async () => {
    const source = {
      healthRows: [...healthRows],
      breakerRows: [...breakerRows],
    };
    const listSpy = mockProviderHealthReads(source);

    renderWithProviders(<HealthModule />, { capabilities: ['integrations.read'] });

    const healthRow = await screen.findByRole('row', {
      name: /Open provider_health Examplecourier Returns/i,
    });
    fireEvent.click(healthRow);
    expect(within(await screen.findByTestId('provider-health-drawer')).getAllByText('Gateway timeout')).toHaveLength(2);
    expect(listSpy).toHaveBeenCalledTimes(2);

    source.healthRows = [{ ...healthRows[0], error_message: 'Recovered after retry' }];
    source.breakerRows = [{ ...breakerRows[0], last_health_error: 'Recovered after retry' }];

    fireEvent.click(screen.getByRole('button', { name: /Refresh telemetry/i }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledTimes(4);
    });
    expect(await screen.findByText(/refreshed/i)).toBeInTheDocument();
    const drawer = await screen.findByTestId('provider-health-drawer');
    expect(within(drawer).getAllByText('Recovered after retry')).toHaveLength(2);
    expect(within(drawer).queryByText('Gateway timeout')).not.toBeInTheDocument();
  });

  it('opens circuit breaker rows with recovery and last-health context', async () => {
    mockProviderHealthReads();

    renderWithProviders(<HealthModule />, { capabilities: ['integrations.read'] });

    fireEvent.click(await screen.findByText('shipment_status_query'));

    const drawer = await screen.findByTestId('circuit-breaker-drawer');
    expect(within(drawer).getByText('Circuit breaker state')).toBeInTheDocument();
    expect(within(drawer).getByText('Gateway timeout')).toBeInTheDocument();
    expect(within(drawer).getByText('Required')).toBeInTheDocument();
    expect(within(drawer).getByText('shipment_status_query')).toBeInTheDocument();
  });

  it('keeps reset action locked without integration write capability', async () => {
    mockProviderHealthReads({
      healthRows: [{ ...healthRows[0], status: 'down', error_message: 'circuit breaker open' }],
      breakerRows: [{ ...breakerRows[0], state: 'open', last_health_status: 'down', last_health_error: 'circuit breaker open' }],
    });
    const resetSpy = vi.spyOn(apiMod, 'ui_execute_provider_circuit_reset_v1');

    renderWithProviders(<HealthModule />, { capabilities: ['integrations.read'] });

    fireEvent.click(await screen.findByText('shipment_status_query'));

    const resetButton = await screen.findByRole('button', { name: /Reset breaker/i });
    expect(resetButton).toBeDisabled();
    fireEvent.click(resetButton);
    expect(resetSpy).not.toHaveBeenCalled();
  });

  it('keeps recovery probe action locked without integration write capability', async () => {
    mockProviderHealthReads();
    const probeSpy = vi.spyOn(apiMod, 'ui_execute_provider_circuit_probe_v1');

    renderWithProviders(<HealthModule />, { capabilities: ['integrations.read'] });

    fireEvent.click(await screen.findByText('shipment_status_query'));

    const probeButton = await screen.findByRole('button', { name: /Run recovery probe/i });
    expect(probeButton).toBeDisabled();
    fireEvent.click(probeButton);
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it('resets an open circuit breaker and refreshes the same drawer from backend readback', async () => {
    const source: ProviderHealthReadSource = {
      healthRows: [{ ...healthRows[0], status: 'down', error_message: 'circuit breaker open' }],
      breakerRows: [{ ...breakerRows[0], state: 'open', last_health_status: 'down', last_health_error: 'circuit breaker open' }],
    };
    const listSpy = mockProviderHealthReads(source);
    const resetSpy = vi.spyOn(apiMod, 'ui_execute_provider_circuit_reset_v1').mockImplementation(async (args) => {
      source.healthRows = [{ ...source.healthRows[0], status: 'healthy', error_message: null }];
      source.breakerRows = [{
        ...source.breakerRows[0],
        state: 'closed',
        failure_rate: 0,
        last_health_status: 'healthy',
        last_health_error: null,
        manual_intervention_required: false,
      }];
      return {
        ok: true,
        provider_id: args.provider_id,
        operation_name: args.operation_name,
        state: 'closed',
        health_status: 'healthy',
        decision_log_id: 'dec-reset-1',
        correlation_id: 'corr-reset-1',
      };
    });

    renderWithProviders(<HealthModule />, { capabilities: ['integrations.read', 'integrations.write'] });

    fireEvent.click(await screen.findByText('shipment_status_query'));
    expect(await screen.findByRole('button', { name: /Reset breaker/i })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /Reset breaker/i }));

    await waitFor(() => {
      expect(resetSpy).toHaveBeenCalledWith({
        provider_id: 'prv_examplecourier_rto',
        operation_name: 'shipment_status_query',
        reason: 'Console Provider Health operator reset',
      });
    });
    await waitFor(() => expect(listSpy.mock.calls.length).toBeGreaterThanOrEqual(4));

    const drawer = await screen.findByTestId('circuit-breaker-drawer');
    expect(within(drawer).getByText('Closed')).toBeInTheDocument();
    expect(within(drawer).getByText('healthy')).toBeInTheDocument();
    const readback = await screen.findByTestId('provider-circuit-reset-readback');
    expect(within(readback).getByText('Reset confirmed')).toBeInTheDocument();
    expect(within(readback).getByText('dec-reset-1')).toBeInTheDocument();
    expect(screen.getByText('Open breakers')).toBeInTheDocument();
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
  });

  it('probes a half-open circuit breaker and refreshes the same drawer from backend readback', async () => {
    const source: ProviderHealthReadSource = {
      healthRows: [{ ...healthRows[0], status: 'degraded', error_message: 'Gateway timeout' }],
      breakerRows: [{ ...breakerRows[0], state: 'half_open', last_health_status: 'degraded', last_health_error: 'Gateway timeout' }],
    };
    const listSpy = mockProviderHealthReads(source);
    const probeSpy = vi.spyOn(apiMod, 'ui_execute_provider_circuit_probe_v1').mockImplementation(async (args) => {
      source.healthRows = [{ ...source.healthRows[0], status: 'healthy', error_message: null }];
      source.breakerRows = [{
        ...source.breakerRows[0],
        state: 'closed',
        failure_rate: 0,
        half_open_test_at: null,
        last_health_status: 'healthy',
        last_health_error: null,
        manual_intervention_required: false,
      }];
      return {
        ok: true,
        provider_id: args.provider_id,
        operation_name: args.operation_name,
        state: 'closed',
        health_status: 'healthy',
        decision_log_id: 'dec-probe-1',
        correlation_id: 'corr-probe-1',
      };
    });

    renderWithProviders(<HealthModule />, { capabilities: ['integrations.read', 'integrations.write'] });

    fireEvent.click(await screen.findByText('shipment_status_query'));
    expect(await screen.findByRole('button', { name: /Run recovery probe/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Reset breaker/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Run recovery probe/i }));

    await waitFor(() => {
      expect(probeSpy).toHaveBeenCalledWith({
        provider_id: 'prv_examplecourier_rto',
        operation_name: 'shipment_status_query',
        reason: 'Console Provider Health recovery probe',
      });
    });
    await waitFor(() => expect(listSpy.mock.calls.length).toBeGreaterThanOrEqual(4));

    const drawer = await screen.findByTestId('circuit-breaker-drawer');
    expect(within(drawer).getByText('Closed')).toBeInTheDocument();
    expect(within(drawer).getByText('healthy')).toBeInTheDocument();
    const readback = await screen.findByTestId('provider-circuit-reset-readback');
    expect(within(readback).getByText('Recovery probe confirmed')).toBeInTheDocument();
    expect(within(readback).getByText('dec-probe-1')).toBeInTheDocument();
    expect(screen.getByText('Open breakers')).toBeInTheDocument();
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
  });
});
