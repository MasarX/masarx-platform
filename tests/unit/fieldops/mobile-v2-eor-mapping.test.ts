// Unit coverage for `mapFieldopsEorEnvelope` — the pure mapper behind
// `useFieldopsEorRpc`.
//
// Engineering re-audit E7 (hidden mock): older `resolve_fieldops_eor_v1`
// only `{summary, checklist, performance_note}` — it never emits
// `route_label` or a `recon` block (proven by migration 202605120200 and
// the pgTAP envelope-shape assertion 0zq). The previous per-field mapper
// fell `routeLabel` and every `recon` field through to the typed fixture,
// so in the production native shell it unconditionally substituted the
// fixture route id (`RT-2026-0502-A`) and recon (42 parcels / 1,240 SAR)
// and presented them as LIVE shift data — and worse, fed the fabricated
// recon into the REAL `submit_fieldops_eod_recon_v1` decision_log write.
//
// These tests pin the honest-degrade contract: a real resolver envelope
// must NOT yield the fixture route/recon. `routeLabel` degrades to "" and
// `recon` to `null`; a partial recon object is rejected wholesale (never
// fabricated field-by-field). The fixture is reachable only via preview
// mode / a genuinely-absent resolver (covered by the hook, not here).

import {
  fieldopsSurfaceQuery,
  mapFieldopsEorEnvelope,
  type MobileV2EorEnvelope,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import type {
  MobileV2EorChecklistItem,
  MobileV2EorSummary,
} from "../../../apps/fieldops/src/mobile-v2-eor-screen";

// The hand-back checklist is process chrome (same four steps for every
// tenant), so it is a legitimate typed-shape fallback.
const FIXTURE_CHECKLIST: ReadonlyArray<MobileV2EorChecklistItem> = Object.freeze([
  Object.freeze({ id: "parcels", icon: "package" as const, label: "Returned undelivered parcels", sub: "14 parcels in vehicle" }),
  Object.freeze({ id: "cash", icon: "cash" as const, label: "Hand over COD cash", sub: "1,240 ؋ collected" }),
  Object.freeze({ id: "devices", icon: "shield" as const, label: "Plug in handheld + scanner", sub: "Battery report uploaded" }),
  Object.freeze({ id: "sync", icon: "cloud-up" as const, label: "Final sync", sub: "3 writes pending" }),
]);

const FIXTURE_SUMMARY: MobileV2EorSummary = Object.freeze({ delivered: 28, total: 42, failed: 3 });

// A representative preview fixture — mirrors MOBILE_V2_PREVIEW_EOR. Its
// `routeLabel` + `recon` are fabricated business data; if the mapper ever
// leaks them behind a live resolver response the assertions below catch it.
const FIXTURE: MobileV2EorEnvelope = Object.freeze({
  summary: FIXTURE_SUMMARY,
  checklist: FIXTURE_CHECKLIST,
  performanceNote: "You're 12% above team average for on-time delivery this week.",
  routeLabel: "RT-2026-0502-A",
  recon: Object.freeze({
    parcelsCount: 42,
    mismatchCount: 0,
    cashDeclared: 1240,
    cashCounted: 1240,
    walletStatus: "synced",
  }),
  lastRecon: null,
});

// Minimal real-resolver envelope: real today
// summary + the static hand-back checklist + a NULL performance note, and
// NO `route_label` / `recon` keys at all.
function realResolverEnvelope(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    summary: { delivered: 19, total: 24, failed: 2 },
    checklist: [
      { id: "parcels", icon: "package", label: "Returned undelivered parcels", sub: "5 parcels in vehicle" },
      { id: "cash", icon: "cash", label: "Hand over COD cash", sub: "See cash drop" },
      { id: "devices", icon: "shield", label: "Plug in handheld + scanner", sub: "Battery report uploaded" },
      { id: "sync", icon: "cloud-up", label: "Final sync", sub: "Outbox check" },
    ],
    performance_note: null,
    ...overrides,
  };
}

describe("mapFieldopsEorEnvelope — E7 honest-degrade", () => {
  test("a real resolver envelope does NOT return the fixture route label", () => {
    const mapped = mapFieldopsEorEnvelope(realResolverEnvelope(), FIXTURE);
    // resolve_fieldops_eor_v1 emits no `route_label` → honest empty string.
    expect(mapped.routeLabel).toBe("");
    expect(mapped.routeLabel).not.toBe(FIXTURE.routeLabel);
  });

  test("a real resolver envelope does NOT return the fixture recon block", () => {
    const mapped = mapFieldopsEorEnvelope(realResolverEnvelope(), FIXTURE);
    // resolve_fieldops_eor_v1 emits no `recon` → honest null, never the
    // fabricated fixture recon that would otherwise feed the real
    // submit_fieldops_eod_recon_v1 decision_log write.
    expect(mapped.recon).toBeNull();
  });

  test("the real today summary passes through, not the fixture summary", () => {
    const mapped = mapFieldopsEorEnvelope(realResolverEnvelope(), FIXTURE);
    expect(mapped.summary).toEqual({ delivered: 19, total: 24, failed: 2 });
    expect(mapped.summary).not.toEqual(FIXTURE.summary);
  });

  test("a NULL performance_note degrades to null, not the fixture note", () => {
    const mapped = mapFieldopsEorEnvelope(realResolverEnvelope(), FIXTURE);
    expect(mapped.performanceNote).toBeNull();
    expect(mapped.performanceNote).not.toBe(FIXTURE.performanceNote);
  });

  test("a resolver-supplied performance note + route label pass through honestly", () => {
    const mapped = mapFieldopsEorEnvelope(
      realResolverEnvelope({
        performance_note: "On-time 96% today",
        route_label: "RT-2026-0701-C",
      }),
      FIXTURE,
    );
    expect(mapped.performanceNote).toBe("On-time 96% today");
    expect(mapped.routeLabel).toBe("RT-2026-0701-C");
  });

  test("a full resolver-supplied recon block maps through honestly", () => {
    const routeRunId = "046b311e-33d2-4d07-802f-694d8698a1eb";
    const mapped = mapFieldopsEorEnvelope(
      realResolverEnvelope({
        recon: {
          parcels_count: 21,
          mismatch_count: 1,
          cash_declared: 880,
          cash_counted: 875,
          wallet_status: "stale",
          route_run_id: routeRunId,
        },
      }),
      FIXTURE,
    );
    expect(mapped.recon).toEqual({
      parcelsCount: 21,
      mismatchCount: 1,
      cashDeclared: 880,
      cashCounted: 875,
      walletStatus: "stale",
      routeRunId,
    });
    // It is the resolver's recon, not the fixture's.
    expect(mapped.recon?.parcelsCount).not.toBe(FIXTURE.recon?.parcelsCount);
  });

  test("a route-scoped last_recon maps through honestly", () => {
    const routeRunId = "046b311e-33d2-4d07-802f-694d8698a1eb";
    const mapped = mapFieldopsEorEnvelope(
      realResolverEnvelope({
        last_recon: {
          decision_log_id: "650fd731-b661-43b2-8d7c-7cd3380db95f",
          state: "with_variances",
          route_run_id: routeRunId,
          parcels_count: 22,
          mismatch_count: 2,
          cash_declared: 910,
          cash_counted: 900,
          cash_variance: -10,
          wallet_status: "stale",
          submitted_at: "2026-05-27T08:30:00.000Z",
        },
      }),
      FIXTURE,
    );

    expect(mapped.lastRecon).toEqual({
      decisionLogId: "650fd731-b661-43b2-8d7c-7cd3380db95f",
      state: "with_variances",
      routeRunId,
      parcelsCount: 22,
      mismatchCount: 2,
      cashDeclared: 910,
      cashCounted: 900,
      cashVariance: -10,
      walletStatus: "stale",
      submittedAt: "2026-05-27T08:30:00.000Z",
    });
  });

  test("a partial last_recon is rejected wholesale", () => {
    const mapped = mapFieldopsEorEnvelope(
      realResolverEnvelope({
        last_recon: {
          decision_log_id: "650fd731-b661-43b2-8d7c-7cd3380db95f",
          state: "clean",
          parcels_count: 22,
          mismatch_count: 0,
          cash_declared: 910,
          cash_counted: 910,
          wallet_status: "synced",
        },
      }),
      FIXTURE,
    );

    expect(mapped.lastRecon).toBeNull();
  });

  test("a PARTIAL recon block is rejected wholesale — never fabricated field-by-field", () => {
    // Missing `wallet_status` — the mapper must not borrow the fixture's
    // wallet status (or any other field) to complete a partial object.
    const mapped = mapFieldopsEorEnvelope(
      realResolverEnvelope({
        recon: { parcels_count: 21, mismatch_count: 1, cash_declared: 880, cash_counted: 875 },
      }),
      FIXTURE,
    );
    expect(mapped.recon).toBeNull();
  });

  test("a non-numeric recon field is rejected wholesale", () => {
    const mapped = mapFieldopsEorEnvelope(
      realResolverEnvelope({
        recon: {
          parcels_count: 21,
          mismatch_count: 1,
          cash_declared: "880",
          cash_counted: 875,
          wallet_status: "synced",
        },
      }),
      FIXTURE,
    );
    expect(mapped.recon).toBeNull();
  });

  // #600: retired "a null payload returns the fixture summary and
  // checklist"; live mode errors.
  test("live mode: a malformed (non-object) resolver payload is an error, never the fixture", () => {
    expect(() => mapFieldopsEorEnvelope(null, FIXTURE)).toThrow(/malformed payload/);
  });

  test("showcase mode: the same malformed input still renders the fixture", async () => {
    const readLive = jest.fn(async () => mapFieldopsEorEnvelope(null, FIXTURE));
    const query = fieldopsSurfaceQuery(null, FIXTURE, readLive);
    expect(query.initialData).toBe(FIXTURE);
    await expect(query.queryFn()).resolves.toBe(FIXTURE);
    expect(readLive).not.toHaveBeenCalled();
  });

  test("the mapped envelope is frozen", () => {
    const mapped = mapFieldopsEorEnvelope(realResolverEnvelope(), FIXTURE);
    expect(Object.isFrozen(mapped)).toBe(true);
  });
});
