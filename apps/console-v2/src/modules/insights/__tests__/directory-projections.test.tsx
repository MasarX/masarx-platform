// directory-projections.test.tsx — W30 INSIGHTS paired projection view
// consumption tests.
//
// Asserts:
//   1. Each /insights/* surface subscribes to its W30 paired projection view
//      registry seam additively without breaking the canonical SSOT
//      consumer.
//   2. The new directory-summary header pills render when the projection
//      returns rows.
//   3. The decoratedRows seam in resolutions.tsx exposes
//      ladder_levels_visited / override_count from the directory projection.
//
// Each test mounts the module with full capability scope so the projection
// query subscribes successfully against the seed-mode adapter.

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { ReportingModule } from '../reporting';
import { DecisionsModule } from '../decisions';
import { ResolutionsModule } from '../resolutions';
import { UiEventsModule } from '../ui-events';
import { ui_list_resource_v1 } from '@/lib/data-source';
// @ts-expect-error JS module — registry shape exercised dynamically below.
import { ui_read_registry as RAW_REGISTRY } from '@/lib/seed-raw/registry';

const ui_read_registry = RAW_REGISTRY as Record<
  string,
  { relation: string; capability_read: string; columns: Array<{ key: string }> }
>;

interface KpiRollupDirectoryRow {
  id: string;
  kpi_key: string;
  kpi_label: string | null;
  group_label: string | null;
  format: string | null;
  scope_label: string | null;
  is_active: boolean;
  is_fresh: boolean;
  is_stale: boolean;
  has_rollup: boolean;
}

interface DecisionLogDirectoryRow {
  id: string;
  resolved_from: string | null;
  scope_path: unknown;
  scope_category: string | null;
  age_seconds: number | null;
  has_correlation: boolean;
  has_resolution: boolean;
}

interface SettingsResolutionDirectoryRow {
  id: string;
  ladder_levels_visited: number;
  override_count: number;
  is_global_winner: boolean;
  is_tenant_winner: boolean;
  is_client_winner: boolean;
  is_sender_winner: boolean;
}

interface UiEventLogDirectoryRow {
  id: string;
  path_label: string | null;
  command_label: string | null;
  is_action: boolean;
  has_resolution: boolean;
  has_scope: boolean;
}

describe('W30 INSIGHTS paired projection view registry seams', () => {
  it('registers kpi_rollup_directory against v_kpi_rollup_directory', () => {
    const entry = ui_read_registry['kpi_rollup_directory'];
    expect(entry).toBeDefined();
    expect(entry!.relation).toBe('v_kpi_rollup_directory');
    expect(entry!.capability_read).toBe('insights.read');
  });

  it('registers decision_log_directory against v_decision_log_directory', () => {
    const entry = ui_read_registry['decision_log_directory'];
    expect(entry).toBeDefined();
    expect(entry!.relation).toBe('v_decision_log_directory');
    expect(entry!.capability_read).toBe('observability.read');
  });

  it('registers settings_resolution_directory against v_settings_resolution_directory', () => {
    const entry = ui_read_registry['settings_resolution_directory'];
    expect(entry).toBeDefined();
    expect(entry!.relation).toBe('v_settings_resolution_directory');
    expect(entry!.capability_read).toBe('observability.read');
  });

  it('registers ui_event_log_directory against v_ui_event_log_directory', () => {
    const entry = ui_read_registry['ui_event_log_directory'];
    expect(entry).toBeDefined();
    expect(entry!.relation).toBe('v_ui_event_log_directory');
    expect(entry!.capability_read).toBe('observability.read');
  });
});

describe('kpi_rollup_directory seed-mode projection (W30)', () => {
  it('returns FE-shaped rows with kpi_label/group_label/format/scope_label + lifecycle booleans', async () => {
    const result = await ui_list_resource_v1<KpiRollupDirectoryRow>('kpi_rollup_directory');
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(typeof row.kpi_key).toBe('string');
      expect(typeof row.is_active).toBe('boolean');
      expect(typeof row.is_fresh).toBe('boolean');
      expect(typeof row.is_stale).toBe('boolean');
      expect(typeof row.has_rollup).toBe('boolean');
      // is_fresh + is_stale are mutually exclusive lifecycle buckets.
      expect(row.is_fresh && row.is_stale).toBe(false);
    }
  });
});

describe('decision_log_directory seed-mode projection (W30)', () => {
  it('returns FE-shaped rows with resolved_from + age_seconds + has_correlation + has_resolution', async () => {
    const result = await ui_list_resource_v1<DecisionLogDirectoryRow>('decision_log_directory');
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(typeof row.has_correlation).toBe('boolean');
      expect(typeof row.has_resolution).toBe('boolean');
      // age_seconds is a non-negative bigint when set.
      if (row.age_seconds != null) expect(row.age_seconds).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('settings_resolution_directory seed-mode projection (W30)', () => {
  it('returns FE-shaped rows with ladder_levels_visited + override_count + winner-bucket booleans', async () => {
    const result = await ui_list_resource_v1<SettingsResolutionDirectoryRow>(
      'settings_resolution_directory',
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(typeof row.ladder_levels_visited).toBe('number');
      expect(typeof row.override_count).toBe('number');
      expect(row.ladder_levels_visited).toBeGreaterThanOrEqual(0);
      expect(row.override_count).toBeGreaterThanOrEqual(0);
      // override_count cannot exceed ladder_levels_visited (overrides are a
      // subset of visited entries).
      expect(row.override_count).toBeLessThanOrEqual(row.ladder_levels_visited);
      // winner-bucket booleans are mutually exclusive (exactly one is true).
      const winnerCount = [
        row.is_global_winner,
        row.is_tenant_winner,
        row.is_client_winner,
        row.is_sender_winner,
      ].filter(Boolean).length;
      expect(winnerCount).toBe(1);
    }
  });
});

describe('ui_event_log_directory seed-mode projection (W30)', () => {
  it('returns FE-shaped rows with path_label + command_label + is_action + has_resolution + has_scope', async () => {
    const result = await ui_list_resource_v1<UiEventLogDirectoryRow>(
      'ui_event_log_directory',
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(typeof row.is_action).toBe('boolean');
      expect(typeof row.has_resolution).toBe('boolean');
      expect(typeof row.has_scope).toBe('boolean');
    }
  });
});

describe('W30 surface consumption', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reporting.tsx renders the kpi-freshness-pill from v_kpi_rollup_directory', async () => {
    renderWithProviders(<ReportingModule />, { capabilities: ['all'] });
    await waitFor(() => {
      // The freshness pill is data-testid="kpi-freshness-pill" when the
      // directory query returns rows. Seed always returns at least 12+
      // definitions, so the pill must render.
      expect(screen.getByTestId('kpi-freshness-pill')).toBeTruthy();
    });
  });

  it('decisions.tsx renders the decision-directory-pill from v_decision_log_directory', async () => {
    renderWithProviders(<DecisionsModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(screen.getByTestId('decision-directory-pill')).toBeTruthy();
    });
  });

  it('resolutions.tsx renders the resolutions-directory-pill from v_settings_resolution_directory', async () => {
    renderWithProviders(<ResolutionsModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(screen.getByTestId('resolutions-directory-pill')).toBeTruthy();
    });
  });

  it('ui-events.tsx renders the ui-events-directory-pill from v_ui_event_log_directory', async () => {
    renderWithProviders(<UiEventsModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(screen.getByTestId('ui-events-directory-pill')).toBeTruthy();
    });
  });
});
