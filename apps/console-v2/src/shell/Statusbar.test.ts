import { describe, expect, it } from 'vitest';

import {
  deriveStatusbarMetrics,
  formatDecisionCategory,
  formatProviderTelemetryHealth,
  formatProviderTelemetryLatency,
} from './Statusbar';

describe('formatDecisionCategory', () => {
  it('uses command labels instead of exposing raw command keys', () => {
    expect(
      formatDecisionCategory('service_offerings.create', {
        commands: [{ key: 'service_offerings.create', label: 'New offering' }],
      }),
    ).toBe('New offering');
  });

  it('humanizes unknown technical categories for the status bar', () => {
    expect(formatDecisionCategory('workflow_run.failed', { commands: [] })).toBe('Workflow Run Failed');
  });

  it('derives statusbar counters from resource rows instead of static demo values', () => {
    expect(
      deriveStatusbarMetrics({
        providerHealthRows: [
          { status: 'healthy', latency_ms: 120 },
          { status: 'degraded', metadata: { avg_latency_ms: '880' } },
        ],
        workflowRunRows: [
          { status: 'running', is_active: true },
          { status: 'succeeded' },
        ],
        commsAttemptRows: [
          { status: 'queued' },
          { status: 'sent' },
        ],
        ndrTaskRows: [{ id: 'tsk_1' }],
        atRiskTaskRows: [{ id: 'tsk_2' }, { id: 'tsk_3' }],
      }),
    ).toMatchObject({
      latencyMs: 500,
      integrationOk: 1,
      integrationTotal: 2,
      activeWorkflowRuns: 1,
      queuedComms: 1,
      ndrTasks: 1,
      atRiskTasks: 2,
    });
  });

  it('formats provider telemetry states without false outage copy', () => {
    const emptyMetrics = {
      latencyMs: null,
      integrationOk: 0,
      integrationTotal: 0,
    };

    expect(formatProviderTelemetryLatency({ canRead: false, metrics: emptyMetrics })).toBe('restricted');
    expect(formatProviderTelemetryHealth({ canRead: false, metrics: emptyMetrics })).toBe('restricted');

    expect(formatProviderTelemetryLatency({ canRead: true, isLoading: true, metrics: emptyMetrics })).toBe('loading');
    expect(formatProviderTelemetryHealth({ canRead: true, isLoading: true, metrics: emptyMetrics })).toBe('loading');

    expect(formatProviderTelemetryLatency({ canRead: true, metrics: emptyMetrics })).toBe('not configured');
    expect(formatProviderTelemetryHealth({ canRead: true, metrics: emptyMetrics })).toBe('0 providers');

    const liveMetrics = {
      latencyMs: 240,
      integrationOk: 1,
      integrationTotal: 2,
    };
    expect(formatProviderTelemetryLatency({ canRead: true, metrics: liveMetrics })).toBe('240ms');
    expect(formatProviderTelemetryHealth({ canRead: true, metrics: liveMetrics })).toBe('1/2 ok');
  });
});
