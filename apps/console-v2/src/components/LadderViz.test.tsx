// LadderViz.test.tsx — W14-6 closure.
//
// LadderViz is dual-shape: it accepts both the in-flight `SettingsResolution`
// (the resolveSettings RPC return) and the persisted `ResolutionLogRow` (a
// row from `public.settings_resolution_log` with canonical column names).
// These tests pin the normalization contract so future drift to either shape
// surfaces here first.

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LadderViz } from './LadderViz';
import type {
  ResolutionLogRow,
  SettingsResolution,
} from '../types/domain';

describe('LadderViz (W14-6 dual-shape)', () => {
  it('renders nothing when resolution is null/undefined', () => {
    const { container } = render(<LadderViz resolution={null} />);
    // The wrapper exists but contains no `.ladder__step` rows.
    expect(container.querySelectorAll('.ladder__step').length).toBe(0);
  });

  it('renders SettingsResolution shape (legacy in-flight resolver result)', () => {
    const resolution: SettingsResolution = {
      category: 'route_assignment_policy',
      value: { capacity: 22 },
      resolved_from: 'tenant',
      ladder_path: [
        { rank: 0, scope_type: 'global', scope_id: 'global', has_value: true, value: { capacity: 18 } },
        { rank: 10, scope_type: 'tenant', scope_id: 'org_rashed', has_value: true, value: { capacity: 22 } },
        { rank: 20, scope_type: 'client', scope_id: null, has_value: false, value: undefined },
      ],
      settings_resolution_id: 'srlv_test_1',
      override_of: null,
    };
    const { container } = render(<LadderViz resolution={resolution} />);
    const steps = container.querySelectorAll('.ladder__step');
    expect(steps.length).toBe(3);
    // Winning scope = tenant (matches resolved_from + has_value); receives is-match.
    const matchSteps = container.querySelectorAll('.ladder__step.is-match');
    expect(matchSteps.length).toBe(1);
    expect(matchSteps[0]?.textContent).toContain('tenant');
    // Empty scope receives is-dim.
    const dimSteps = container.querySelectorAll('.ladder__step.is-dim');
    expect(dimSteps.length).toBe(1);
    expect(dimSteps[0]?.textContent).toContain('client');
  });

  it('renders canonical ResolutionLogRow shape (settings_resolution_log row)', () => {
    const row: ResolutionLogRow = {
      id: 'srlv_canonical_1',
      organization_id: 'org_rashed',
      category: 'pod.required_evidence',
      scope_path: [
        { rank: 0, scope_type: 'global', scope_id: 'global', has_value: true, version: 14, value: ['photo'] },
        { rank: 10, scope_type: 'tenant', scope_id: 'org_rashed', has_value: false },
        { rank: 20, scope_type: 'client', scope_id: 'cl_exampleparcel_ksa', has_value: true, version: 3, value: ['photo', 'signature'] },
      ],
      winning_scope_type: 'client',
      winning_scope_id: 'cl_exampleparcel_ksa',
      winning_settings_id: 'set_pod_client',
      winning_settings_version_id: 'sv_pod_client_v3',
      winning_version: 3,
      resolved_at: '2026-04-25T13:30:00Z',
    };
    const { container } = render(<LadderViz resolution={row} />);
    const steps = container.querySelectorAll('.ladder__step');
    expect(steps.length).toBe(3);
    // Winning scope = client (winning_scope_type + has_value); receives is-match.
    const matchSteps = container.querySelectorAll('.ladder__step.is-match');
    expect(matchSteps.length).toBe(1);
    expect(matchSteps[0]?.textContent).toContain('client');
    // Tenant has no value -> is-dim.
    const dimSteps = container.querySelectorAll('.ladder__step.is-dim');
    expect(dimSteps.length).toBe(1);
    expect(dimSteps[0]?.textContent).toContain('tenant');
  });

  it('renders the canonical step rank (no SCOPE_RANK literal substitution)', () => {
    // scope_type_registry-driven ranks: Global 0 < Tenant 10 < Client 20.
    const row: ResolutionLogRow = {
      id: 'srlv_canonical_2',
      category: 'address_policy',
      scope_path: [
        { rank: 0, scope_type: 'global', scope_id: 'global', has_value: true, value: 'A' },
        { rank: 10, scope_type: 'tenant', scope_id: 'org_x', has_value: false },
        { rank: 20, scope_type: 'client', scope_id: 'cl_y', has_value: true, value: 'B' },
      ],
      winning_scope_type: 'client',
      winning_scope_id: 'cl_y',
      winning_version: 1,
      resolved_at: '2026-04-25T13:30:00Z',
    };
    const { container } = render(<LadderViz resolution={row} />);
    const ranks = Array.from(container.querySelectorAll('.ladder__rank')).map(
      (el) => el.textContent,
    );
    expect(ranks).toEqual(['0', '10', '20']);
  });

  it('summarizes object policy values instead of rendering raw JSON', () => {
    const resolution: SettingsResolution = {
      category: 'route_assignment_policy',
      value: { version: 1, enabled: true, source: 'policy' },
      resolved_from: 'global',
      ladder_path: [
        {
          rank: 0,
          scope_type: 'global',
          scope_id: 'global',
          has_value: true,
          value: { version: 1, enabled: true, source: 'policy', nested: { mode: 'internal' } },
        },
      ],
      settings_resolution_id: 'srlv_object_summary',
      override_of: null,
    };

    const { container } = render(<LadderViz resolution={resolution} />);
    const value = container.querySelector('.ladder__value');
    expect(value?.textContent).toContain('version: 1');
    expect(value?.textContent).toContain('enabled: true');
    expect(value?.textContent).not.toContain('{"version"');
  });
});
