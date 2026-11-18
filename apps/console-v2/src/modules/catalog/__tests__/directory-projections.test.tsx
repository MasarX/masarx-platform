// directory-projections.test.tsx — W31 CATALOG paired projection view
// consumption tests.
//
// Asserts:
//   1. Each /catalog registry seam (service_offering_directory /
//      service_level_directory / lookup_definition_directory) resolves to
//      its canonical view relation with the correct capability gate.
//   2. The seed-mode projection seam exposes the FE-shaped derived
//      columns the canonical SQL view returns
//      (supabase/migrations/202604302900_v_service_offering_directory.sql,
//       supabase/migrations/202604302910_v_service_level_directory.sql,
//       supabase/migrations/202604302920_v_lookup_definition_directory.sql).
//   3. Cross-row invariants (active_subscription_count >= 0,
//      offering_count >= active_offering_count, has_default ⇔ default_value
//      not null) hold for every row.
//
// Production cutover: a single getSupabaseClient() branch in
// ui_list_resource_v1 returns the canonical view rows; module call sites
// stay stable because resolution is registry-driven.

import { describe, it, expect } from 'vitest';
import { ui_list_resource_v1 } from '@/lib/data-source';
// @ts-expect-error JS module — registry shape exercised dynamically below.
import { ui_read_registry as RAW_REGISTRY } from '@/lib/seed-raw/registry';

const ui_read_registry = RAW_REGISTRY as Record<
  string,
  { relation: string; capability_read: string; columns: Array<{ key: string }> }
>;

interface ServiceOfferingDirectoryRow {
  id: string;
  service_level_id: string | null;
  branch_id: string | null;
  zone_id: string | null;
  level_key: string | null;
  level_name: string | null;
  tenant_label: string | null;
  branch_name: string | null;
  zone_label: string | null;
  display_name: string | null;
  display_slug: string | null;
  effective_status: string;
  base_price: number | null;
  currency: string | null;
  max_weight_kg: number | null;
  active_subscription_count: number;
  is_active_window: boolean;
  is_archived: boolean;
  is_draft: boolean;
  age_seconds: number;
  age_hours: number;
}

interface ServiceLevelDirectoryRow {
  id: string;
  organization_id: string | null;
  key: string | null;
  name: string | null;
  is_active: boolean;
  tenant_label: string | null;
  tier: string | null;
  priority_rank: number | null;
  sla_minutes: number | null;
  sla_label: string | null;
  color_token: string | null;
  offering_count: number;
  active_offering_count: number;
  active_subscription_count: number;
  age_seconds: number;
  age_hours: number;
}

interface LookupDefinitionDirectoryRow {
  id: string;
  category: string;
  is_mutable: boolean;
  value_count: number;
  active_value_count: number;
  draft_value_count: number;
  archived_value_count: number;
  retired_value_count: number;
  default_value: string | null;
  default_value_label: string | null;
  has_default: boolean;
  age_seconds: number;
  age_hours: number;
}

describe('W31 CATALOG paired projection view registry seams', () => {
  it('registers service_offering_directory against v_service_offering_directory', () => {
    const entry = ui_read_registry['service_offering_directory'];
    expect(entry).toBeDefined();
    expect(entry!.relation).toBe('v_service_offering_directory');
    expect(entry!.capability_read).toBe('service_offerings.read');
  });

  it('registers service_level_directory against v_service_level_directory', () => {
    const entry = ui_read_registry['service_level_directory'];
    expect(entry).toBeDefined();
    expect(entry!.relation).toBe('v_service_level_directory');
    expect(entry!.capability_read).toBe('service_offerings.read');
  });

  it('registers lookup_definition_directory against v_lookup_definition_directory', () => {
    const entry = ui_read_registry['lookup_definition_directory'];
    expect(entry).toBeDefined();
    expect(entry!.relation).toBe('v_lookup_definition_directory');
    expect(entry!.capability_read).toBe('lookups.read');
  });
});

describe('service_offering_directory seed-mode projection (W31)', () => {
  it('returns FE-shaped rows with derived joins + display + counters', async () => {
    const result = await ui_list_resource_v1<ServiceOfferingDirectoryRow>(
      'service_offering_directory',
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      // Canonical id + service_level_id pointers must be present.
      expect(typeof row.id).toBe('string');
      // effective_status is one of canonical lookup values.
      expect(['active', 'draft', 'archived']).toContain(row.effective_status);
      // is_archived/is_draft are booleans derived from effective_status.
      expect(typeof row.is_archived).toBe('boolean');
      expect(typeof row.is_draft).toBe('boolean');
      expect(row.is_archived).toBe(row.effective_status === 'archived');
      expect(row.is_draft).toBe(row.effective_status === 'draft');
      // Cross-bucket exclusivity: cannot be both archived and draft.
      expect(row.is_archived && row.is_draft).toBe(false);
      // Counter is non-negative.
      expect(row.active_subscription_count).toBeGreaterThanOrEqual(0);
      // Temporal projections are non-negative integers.
      expect(row.age_seconds).toBeGreaterThanOrEqual(0);
      expect(row.age_hours).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('service_level_directory seed-mode projection (W31)', () => {
  it('returns FE-shaped rows with metadata projection + offering counters', async () => {
    const result = await ui_list_resource_v1<ServiceLevelDirectoryRow>(
      'service_level_directory',
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(typeof row.id).toBe('string');
      // Counters are non-negative.
      expect(row.offering_count).toBeGreaterThanOrEqual(0);
      expect(row.active_offering_count).toBeGreaterThanOrEqual(0);
      expect(row.active_subscription_count).toBeGreaterThanOrEqual(0);
      // active_offering_count cannot exceed offering_count (active is a
      // subset of all offerings).
      expect(row.active_offering_count).toBeLessThanOrEqual(row.offering_count);
      // Temporal projections.
      expect(row.age_seconds).toBeGreaterThanOrEqual(0);
      expect(row.age_hours).toBeGreaterThanOrEqual(0);
    }
  });

  it('exposes metadata projection (tier, priority_rank, sla_minutes) when present in seed', async () => {
    const result = await ui_list_resource_v1<ServiceLevelDirectoryRow>(
      'service_level_directory',
    );
    // At least one seeded level must have a tier projection (express,
    // economy, standard, same_day, white_glove).
    const withTier = result.rows.filter((r) => r.tier != null);
    expect(withTier.length).toBeGreaterThan(0);
    // priority_rank when present must be a finite number.
    for (const r of withTier) {
      if (r.priority_rank != null) {
        expect(Number.isFinite(r.priority_rank)).toBe(true);
      }
    }
  });
});

describe('lookup_definition_directory seed-mode projection (W31)', () => {
  it('returns FE-shaped rows with per-definition counters + default-value resolution', async () => {
    const result = await ui_list_resource_v1<LookupDefinitionDirectoryRow>(
      'lookup_definition_directory',
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(typeof row.category).toBe('string');
      expect(row.value_count).toBeGreaterThanOrEqual(0);
      expect(row.active_value_count).toBeGreaterThanOrEqual(0);
      expect(row.draft_value_count).toBeGreaterThanOrEqual(0);
      expect(row.archived_value_count).toBeGreaterThanOrEqual(0);
      expect(row.retired_value_count).toBeGreaterThanOrEqual(0);
      // active + draft + archived counts cannot exceed total value_count
      // (status is a partition of the rows; retired_at is orthogonal).
      const statusSum =
        row.active_value_count + row.draft_value_count + row.archived_value_count;
      expect(statusSum).toBeLessThanOrEqual(row.value_count);
      // has_default ⇔ default_value not null + default_value_label not null.
      expect(row.has_default).toBe(row.default_value != null);
      if (row.has_default) {
        expect(row.default_value_label).not.toBeNull();
      }
      expect(row.age_seconds).toBeGreaterThanOrEqual(0);
      expect(row.age_hours).toBeGreaterThanOrEqual(0);
    }
  });

  it('exposes at least one definition with active values from the canonical lookup catalog', async () => {
    const result = await ui_list_resource_v1<LookupDefinitionDirectoryRow>(
      'lookup_definition_directory',
    );
    // The seed-merged lookups catalog (service_offering_status,
    // service_level_tier, dispute_status, etc.) must produce active values
    // on at least one definition row.
    const withActive = result.rows.filter((r) => r.active_value_count > 0);
    expect(withActive.length).toBeGreaterThan(0);
  });
});
