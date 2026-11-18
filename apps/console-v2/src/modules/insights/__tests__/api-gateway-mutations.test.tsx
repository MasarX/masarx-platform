// api-gateway-mutations.test.tsx — REAUDIT INSIGHTS §D2-A closure (W9-3).
//
// Coverage targets:
//   1. Block source submit fires `block_api_gateway_source_v1` with the
//      canonical `{ source_id, reason }` payload.
//   2. Block source action stays gated by `api_gateway.write` (no implicit
//      RPC invocation when capability is missing).
//   3. Adjust rate-limit submit fires `adjust_api_gateway_rate_limit_v1`
//      with `{ source_id, limit_per_min }` (FE per-min display value).
//   4. Adjust rate-limit action stays gated by `api_gateway.write`.
//
// Strategy: spy on the canonical RPC facades exported by `@/lib/api`
// (`block_api_gateway_source_v1` + `adjust_api_gateway_rate_limit_v1`) and
// drive the module's modal forms to submit. The deterministic seed populates
// `webhook_sources` + `api_gateway_rate_limits` so the modal selects always
// have at least one option.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { ApiGatewayModule } from '../api-gateway';
import * as api from '@/lib/api';

const CONTROL_SOURCE_ID = 'src_api_control_proof';

function listResult(rows: Array<Record<string, unknown>>) {
  return {
    rows,
    total: rows.length,
    page: 0,
    page_size: 50,
  };
}

function installApiGatewayControlReadbackMocks() {
  let sourceRows: Array<Record<string, unknown>> = [
    {
      id: CONTROL_SOURCE_ID,
      name: 'Control Proof API Source',
      source_identifier: 'control-proof-api-source',
      provider_type: 'api_gateway',
      enabled: true,
      auth_token_masked: 'stored',
      sender_id: 'snd_control_proof',
      sender_label: 'Control Proof Sender',
      client_id: 'cli_control_proof',
      client_label: 'Control Proof Client',
      mapping_config_id: 'map_control_proof',
      mapping_label: 'Control Proof mapping',
      rate_limit_per_hour: 960,
    },
  ];
  let rateRows: Array<Record<string, unknown>> = [
    {
      id: 'bucket_control_proof',
      source_id: CONTROL_SOURCE_ID,
      source_label: 'Control Proof API Source',
      limit_per_min: 16,
      limit_per_hour: 960,
      current_usage: 0,
      request_count: 0,
      saturated: false,
      window_start: '2026-05-23T09:00:00.000Z',
      updated_at: '2026-05-23T09:00:00.000Z',
    },
  ];
  const originalList = api.ui_list_resource_v1;
  const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
    async (resource, opts) => {
      if (resource === 'webhook_source_directory') {
        return listResult(sourceRows) as never;
      }
      if (resource === 'api_gateway_rate_limits_summary') {
        return listResult(rateRows) as never;
      }
      if (
        resource === 'api_gateway_observability' ||
        resource === 'api_call_log' ||
        resource === 'api_gateway_requests' ||
        resource === 'api_gateway_auth_rejections'
      ) {
        return listResult([]) as never;
      }
      return originalList(resource, opts) as never;
    },
  );
  return {
    get sourceRows() {
      return sourceRows;
    },
    get rateRows() {
      return rateRows;
    },
    setSourceRows(next: Array<Record<string, unknown>>) {
      sourceRows = next;
    },
    setRateRows(next: Array<Record<string, unknown>>) {
      rateRows = next;
    },
    listSpy,
  };
}

function getControlSourceTableRow() {
  const sourceCell = screen
    .getAllByText('Control Proof API Source')
    .find((node) => node.tagName.toLowerCase() !== 'option' && node.closest('tr'));
  expect(sourceCell).toBeTruthy();
  const row = sourceCell?.closest('tr');
  expect(row).toBeTruthy();
  return row as HTMLElement;
}

describe('ApiGatewayModule — REAUDIT INSIGHTS §D2-A (W9-3)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('Block source submit fires block_api_gateway_source_v1 with canonical payload', async () => {
    const spy = vi
      .spyOn(api, 'block_api_gateway_source_v1')
      .mockResolvedValue({
        ok: true,
        source_id: 'src_exampleparcel_ksa',
        correlation_id: 'cor_test_block',
        settings_resolution_id: 'srlv_test',
        status: 'blocked',
      } as Awaited<ReturnType<typeof api.block_api_gateway_source_v1>>);

    const user = userEvent.setup();
    renderWithProviders(<ApiGatewayModule />, {
      capabilities: ['api_gateway.read', 'api_gateway.write'],
    });
    // Wait for filter bar — confirms canonical api_gateway_thresholds
    // policy resolved and the page is past the policy-not-seeded guard.
    await waitFor(() =>
      expect(screen.getByTestId('api-gateway-filter-bar')).toBeTruthy(),
    );
    const blockBtn = screen.getByRole('button', { name: /Block source/ });
    await user.click(blockBtn);
    await waitFor(() => {
      expect(screen.getByTestId('api-gateway-block-source-form')).toBeTruthy();
    });
    // Reason is required by the form — fill it before submit so happy path
    // mirrors the operator workflow.
    const reason = screen.getByLabelText(/Reason/i);
    await user.type(reason, 'Repeated 5xx burst');
    const submit = within(
      screen.getByTestId('api-gateway-block-source-form'),
    ).getByRole('button', { name: /Block source/ });
    await user.click(submit);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    const payload = spy.mock.calls[0]![0]!;
    expect(payload).toHaveProperty('source_id');
    expect(typeof payload.source_id).toBe('string');
    expect(payload.source_id.length).toBeGreaterThan(0);
    expect(payload.reason).toMatch(/Repeated 5xx burst/);
  });

  it('Block source picker uses backend source directory when recent calls are quiet', async () => {
    const originalList = api.ui_list_resource_v1;
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
      async (resource, opts) => {
        if (resource === 'api_gateway_observability' || resource === 'api_call_log') {
          return { rows: [], total: 0, page: 0, page_size: 50 } as never;
        }
        if (resource === 'webhook_source_directory') {
          return {
            rows: [
              {
                id: 'src_quiet_api_gateway',
                name: 'Quiet backend API source',
                source_identifier: 'quiet-backend-api-source',
                enabled: true,
              },
            ],
            total: 1,
            page: 0,
            page_size: 50,
          } as never;
        }
        return originalList(resource, opts) as never;
      },
    );
    const blockSpy = vi
      .spyOn(api, 'block_api_gateway_source_v1')
      .mockResolvedValue({
        ok: true,
        source_id: 'src_quiet_api_gateway',
        correlation_id: 'cor_test_quiet_block',
        status: 'blocked',
      } as Awaited<ReturnType<typeof api.block_api_gateway_source_v1>>);

    const user = userEvent.setup();
    try {
      renderWithProviders(<ApiGatewayModule />, {
        capabilities: ['api_gateway.read', 'api_gateway.write', 'webhooks.read'],
      });
      await waitFor(() =>
        expect(screen.getByTestId('api-gateway-filter-bar')).toBeTruthy(),
      );

      await user.click(screen.getByRole('button', { name: /Block source/ }));
      const form = await screen.findByTestId('api-gateway-block-source-form');
      const sourceSelect = within(form).getByLabelText(/Source/i) as HTMLSelectElement;
      await waitFor(() => {
        expect(sourceSelect.options.length).toBe(1);
      });
      expect(sourceSelect.value).toBe('src_quiet_api_gateway');
      expect(sourceSelect.options[0]?.textContent).toContain('Quiet backend API source');

      await user.type(within(form).getByLabelText(/Reason/i), 'Quiet source proof');
      await user.click(within(form).getByRole('button', { name: /Block source/ }));

      await waitFor(() => {
        expect(blockSpy).toHaveBeenCalledTimes(1);
      });
      expect(blockSpy.mock.calls[0]?.[0]).toMatchObject({
        source_id: 'src_quiet_api_gateway',
        reason: 'Quiet source proof',
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it('Block source action is gated by api_gateway.write (no implicit RPC)', async () => {
    const spy = vi.spyOn(api, 'block_api_gateway_source_v1');
    renderWithProviders(<ApiGatewayModule />, {
      capabilities: ['api_gateway.read'], // missing api_gateway.write
    });
    await waitFor(() =>
      expect(screen.getByTestId('api-gateway-filter-bar')).toBeTruthy(),
    );
    const blockBtn = screen.getByRole('button', { name: /Block source/ });
    expect(blockBtn).toBeDisabled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('Adjust rate limit submit fires adjust_api_gateway_rate_limit_v1 with limit_per_min', async () => {
    const spy = vi
      .spyOn(api, 'adjust_api_gateway_rate_limit_v1')
      .mockResolvedValue({
        ok: true,
        source_id: 'src_exampleparcel_ksa',
        correlation_id: 'cor_test_adjust',
        settings_resolution_id: 'srlv_test',
        status: 'adjusted',
      } as Awaited<ReturnType<typeof api.adjust_api_gateway_rate_limit_v1>>);

    const user = userEvent.setup();
    renderWithProviders(<ApiGatewayModule />, {
      capabilities: ['api_gateway.read', 'api_gateway.write'],
    });
    // Wait for the backend-backed page shell before opening the modal. The
    // bucket select below is the authoritative rate-limit readiness signal.
    await waitFor(() =>
      expect(screen.getByTestId('api-gateway-filter-bar')).toBeTruthy(),
    );
    // Click "All" range so we always have rendered rows (proves the page has
    // hydrated all parallel useResourceList queries including rate_limits).
    const allRangeBtn = document.querySelector('[data-range="all"]') as HTMLButtonElement;
    await user.click(allRangeBtn);
    await waitFor(() => {
      expect(document.querySelector('.dt__table tbody tr')).toBeTruthy();
    });
    const adjustBtn = screen.getByRole('button', { name: /Adjust rate limit/ });
    await user.click(adjustBtn);
    await waitFor(() => {
      expect(screen.getByTestId('api-gateway-adjust-rate-limit-form')).toBeTruthy();
    });
    // Wait until the bucket select has options (driven by the rate_limits
    // useResourceList settling). Without this, the form's bucket can be null
    // and the submit handler returns early.
    await waitFor(() => {
      const sel = screen.getByLabelText(/Bucket/i) as HTMLSelectElement;
      expect(sel.options.length).toBeGreaterThan(0);
    });
    // Form preselects the first bucket; bump the limit via fireEvent.change
    // so the controlled `<input type="number">` receives the canonical state
    // update before submit (userEvent.type can fire onChange per character
    // which mis-orders state for type=number controlled inputs).
    const limitInput = screen.getByLabelText(/Limit \/ min/i) as HTMLInputElement;
    fireEvent.change(limitInput, { target: { value: '120' } });
    expect(limitInput.value).toBe('120');
    const submit = within(
      screen.getByTestId('api-gateway-adjust-rate-limit-form'),
    ).getByRole('button', { name: /Apply/ });
    await user.click(submit);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    const payload = spy.mock.calls[0]![0]!;
    expect(payload).toHaveProperty('source_id');
    expect(typeof payload.source_id).toBe('string');
    expect(payload.limit_per_min).toBe(120);
  });

  it('Adjust rate limit action is gated by api_gateway.write (no implicit RPC)', async () => {
    const spy = vi.spyOn(api, 'adjust_api_gateway_rate_limit_v1');
    renderWithProviders(<ApiGatewayModule />, {
      capabilities: ['api_gateway.read'],
    });
    await waitFor(() =>
      expect(screen.getByTestId('api-gateway-filter-bar')).toBeTruthy(),
    );
    const adjustBtn = screen.getByRole('button', { name: /Adjust rate limit/ });
    expect(adjustBtn).toBeDisabled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('Block source reconciles the Sources tab from backend readback without reload', async () => {
    const readback = installApiGatewayControlReadbackMocks();
    const blockSpy = vi
      .spyOn(api, 'block_api_gateway_source_v1')
      .mockImplementation(async (args) => {
        readback.setSourceRows([
          {
            ...readback.sourceRows[0],
            enabled: false,
            lifecycle_state: 'disabled',
          },
        ]);
        return {
          ok: true,
          source_id: args.source_id,
          correlation_id: 'cor_control_block',
          status: 'blocked',
        } as Awaited<ReturnType<typeof api.block_api_gateway_source_v1>>;
      });

    const user = userEvent.setup();
    renderWithProviders(<ApiGatewayModule />, {
      capabilities: ['api_gateway.read', 'api_gateway.write', 'webhooks.read'],
    });

    await waitFor(() =>
      expect(screen.getByTestId('api-gateway-filter-bar')).toBeTruthy(),
    );
    await user.click(screen.getByRole('tab', { name: /Sources/ }));

    await waitFor(() => {
      const row = getControlSourceTableRow();
      expect(within(row).getByText('Enabled')).toBeTruthy();
      expect(within(row).getByText('16/min')).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: /Block source/ }));
    const form = await screen.findByTestId('api-gateway-block-source-form');
    await user.type(within(form).getByLabelText(/Reason/i), 'Control block no reload proof');
    await user.click(within(form).getByRole('button', { name: /Block source/ }));

    await waitFor(() => {
      expect(blockSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          source_id: CONTROL_SOURCE_ID,
          reason: 'Control block no reload proof',
        }),
      );
    });
    await waitFor(() => {
      const row = getControlSourceTableRow();
      expect(within(row).getByText('Disabled')).toBeTruthy();
    });
  });

  it('Adjust rate limit reconciles the Sources tab from backend readback without reload', async () => {
    const readback = installApiGatewayControlReadbackMocks();
    const adjustSpy = vi
      .spyOn(api, 'adjust_api_gateway_rate_limit_v1')
      .mockImplementation(async (args) => {
        const nextPerMin = Number(args.limit_per_min ?? 0);
        readback.setSourceRows([
          {
            ...readback.sourceRows[0],
            rate_limit_per_hour: nextPerMin * 60,
          },
        ]);
        readback.setRateRows([
          {
            ...readback.rateRows[0],
            limit_per_min: nextPerMin,
            limit_per_hour: nextPerMin * 60,
          },
        ]);
        return {
          ok: true,
          source_id: args.source_id,
          correlation_id: 'cor_control_rate',
          status: 'adjusted',
        } as Awaited<ReturnType<typeof api.adjust_api_gateway_rate_limit_v1>>;
      });

    const user = userEvent.setup();
    renderWithProviders(<ApiGatewayModule />, {
      capabilities: ['api_gateway.read', 'api_gateway.write', 'webhooks.read'],
    });

    await waitFor(() =>
      expect(screen.getByTestId('api-gateway-filter-bar')).toBeTruthy(),
    );
    await user.click(screen.getByRole('tab', { name: /Sources/ }));
    await waitFor(() => {
      expect(screen.getByText('16/min')).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: /Adjust rate limit/ }));
    const form = await screen.findByTestId('api-gateway-adjust-rate-limit-form');
    const limitInput = within(form).getByLabelText(/Limit \/ min/i) as HTMLInputElement;
    fireEvent.change(limitInput, { target: { value: '33' } });
    await user.type(within(form).getByLabelText(/Reason/i), 'Control rate no reload proof');
    await user.click(within(form).getByRole('button', { name: /Apply/ }));

    await waitFor(() => {
      expect(adjustSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          source_id: CONTROL_SOURCE_ID,
          limit_per_min: 33,
          reason: 'Control rate no reload proof',
        }),
      );
    });
    await waitFor(() => {
      const row = getControlSourceTableRow();
      expect(within(row).getByText('33/min')).toBeTruthy();
      expect(within(row).getByText('1,980')).toBeTruthy();
    });
  });
});
