// lookups-no-duplicates.test.ts — W56-B closure parity tests.
//
// Asserts:
//   F1: No per-feature seed extension silently overrides a category that
//       lookups.js already declared. Each colliding category in W55+ produced
//       a divergent value/tone set; this test guards that regression class.
//   F7: Every entry in `lookup_definitions` has at least one canonical row
//       in `lookups[category]` (no orphaned definitions without values).
//
// Runtime guard counterpart lives in `seed-raw/lookups.js` as
// `assertNoLookupCollision(extension, sourceFile)`. The assert is structurally
// guarded here; production seeds use the async load order in seed.js.

import { describe, expect, it } from 'vitest';
import {
  BASE_LOOKUP_CATEGORIES,
  assertNoLookupCollision,
  lookups,
  lookup_definitions,
  // @ts-expect-error JS module — eagerly imported for runtime registration
} from '../seed-raw/lookups.js';

// Eagerly import every per-feature seed file that mutates `lookups` so the
// composite registry is fully materialised before the parity assertions run.
// Mirrors the import order in seed-raw/seed.js (which re-exports each
// module). Keep this list in lockstep with seed.js so a new domain seed is
// caught by the parity test on first commit.
import '../seed-raw/fleet-drivers.js';
import '../seed-raw/driver-applications.js';
import '../seed-raw/fleet-vehicles.js';
import '../seed-raw/network-zones.js';
import '../seed-raw/baskets.js';
import '../seed-raw/network-branches.js';
import '../seed-raw/network-marketplace.js';
import '../seed-raw/finance-billing.js';
import '../seed-raw/catalog-offerings.js';
import '../seed-raw/support.js';
import '../seed-raw/platform-alerts.js';
import '../seed-raw/platform-flags.js';
import '../seed-raw/insights-apigw.js';
import '../seed-raw/identity-sessions.js';
import '../seed-raw/imports.js';

describe('seed-raw/lookups · F1 — no duplicate categories across base + per-feature seeds', () => {
  it('exposes BASE_LOOKUP_CATEGORIES snapshot', () => {
    const baseSet = BASE_LOOKUP_CATEGORIES as readonly string[];
    expect(Array.isArray(baseSet)).toBe(true);
    expect(baseSet.length).toBeGreaterThan(0);
    // Sanity: the snapshot must include core categories that have always
    // lived in lookups.js (these are NOT extensions).
    expect(baseSet).toContain('shipment_status');
    expect(baseSet).toContain('scope_type');
    expect(baseSet).toContain('decision_category');
  });

  it('assertNoLookupCollision throws on a colliding key', () => {
    expect(() =>
      assertNoLookupCollision({ shipment_status: [] }, 'fake-collision-test'),
    ).toThrow(/Lookup collision/);
  });

  it('assertNoLookupCollision passes on a fresh key', () => {
    expect(() =>
      assertNoLookupCollision(
        { __test_only_unique_category_xyz: [] },
        'fresh-key-test',
      ),
    ).not.toThrow();
  });

  // Smoke: the per-feature seeds we de-duped in W56-B must NOT silently
  // override base categories any longer. After W56-B the base lookups.js
  // declared none of these categories, so the per-feature owner is the
  // single SSOT for each.
  const PER_FEATURE_OWNED = [
    // network-branches.js owns branch_type / branch_status / branch_*
    'branch_type',
    'branch_status',
    // network-zones.js owns zone_status / zone_override_status / zone_color_token
    'zone_status',
    'zone_override_status',
    'zone_color_token',
    // baskets.js owns basket_* and policy-editor option lookups
    'basket_state',
    'basket_type',
    'basket_policy_service_match_field',
    'basket_policy_route_key_path',
    // network-marketplace.js owns marketplace_*_status
    'marketplace_offer_status',
    'marketplace_award_status',
    'marketplace_contract_status',
    'marketplace_request_status',
    // finance-billing.js owns invoice_status / subscription_status / agreement_status / usage_event_kind
    'invoice_status',
    'subscription_status',
    'agreement_status',
    'usage_event_kind',
    // support.js owns support_case_status / support_case_priority / support_case_event_type / support_message_channel
    'support_case_status',
    'support_case_priority',
    'support_case_event_type',
    'support_message_channel',
    // fleet-vehicles.js owns vehicle_event_type / vehicle_status / vehicle_kind
    'vehicle_event_type',
    'vehicle_status',
    // platform-alerts.js owns alert_severity / alert_channel / alert_trigger_status
    'alert_severity',
    'alert_channel',
    'alert_trigger_status',
  ];

  it('every per-feature owned category resolves to a non-empty row set', () => {
    for (const cat of PER_FEATURE_OWNED) {
      const list = (lookups as Record<string, unknown[]>)[cat];
      expect(list, `lookups.${cat} should be defined`).toBeDefined();
      expect(Array.isArray(list)).toBe(true);
      expect(list!.length, `lookups.${cat} should have at least one row`).toBeGreaterThan(0);
    }
  });

  it('every per-feature owned category is NOT declared in BASE_LOOKUP_CATEGORIES (per-feature is the SSOT)', () => {
    const baseSet = new Set(BASE_LOOKUP_CATEGORIES as readonly string[]);
    for (const cat of PER_FEATURE_OWNED) {
      expect(
        baseSet.has(cat),
        `lookups.js MUST NOT declare ${cat} — per-feature seed owns the SSOT (W56-B F1 closure)`,
      ).toBe(false);
    }
  });
});

describe('seed-raw/lookups · F7 — every lookup_definitions category has at least one canonical row', () => {
  it('every lookup_definitions[].category has lookups[category].length > 0', () => {
    const orphaned: string[] = [];
    for (const def of lookup_definitions as Array<{ category: string }>) {
      const list = (lookups as Record<string, unknown[]>)[def.category];
      if (!Array.isArray(list) || list.length === 0) {
        orphaned.push(def.category);
      }
    }
    expect(
      orphaned,
      `lookup_definitions has categories without canonical rows: [${orphaned.join(', ')}]. `
      + 'Either populate the rows in lookups.js / per-feature seed OR delete the lookup_definitions entry.',
    ).toEqual([]);
  });
});

describe('seed-raw/lookups · F2 + F3 — metadata projection rows', () => {
  it('duty_status carries metadata.swatch_token for every row (HoursOfServiceMeter F2)', () => {
    const rows = (lookups as Record<string, Array<{ value: string; metadata?: { swatch_token?: string } }>>).duty_status;
    expect(rows).toBeDefined();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(
        row.metadata?.swatch_token,
        `duty_status.${row.value}.metadata.swatch_token must be defined`,
      ).toBeTruthy();
      // Reject raw oklch literals — must be a CSS variable token.
      expect(row.metadata!.swatch_token!.startsWith('var(--')).toBe(true);
    }
  });

  it('scope_type carries metadata.rank_letter for every row (ScopePill F3)', () => {
    const rows = (lookups as Record<string, Array<{ value: string; metadata?: { rank_letter?: string } }>>).scope_type;
    expect(rows).toBeDefined();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(
        row.metadata?.rank_letter,
        `scope_type.${row.value}.metadata.rank_letter must be defined`,
      ).toMatch(/^[A-Z]$/);
    }
  });
});
