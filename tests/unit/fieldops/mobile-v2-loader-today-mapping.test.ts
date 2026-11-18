// Unit coverage for `mapFieldopsLoaderTodayEnvelope` — the pure mapper
// behind `useFieldopsLoaderTodayRpc`.
//
// Engineering re-audit E6 (hidden mock): when `resolve_fieldops_loader_today_v1`
// has no open warehouse_scan ops_session for the caller, it returns
// `wave_label: NULL` / `bay: NULL` / `route_label: NULL` / `cut_off: NULL`.
// The previous per-field mapper fell each missing field through to the
// typed fixture value, so in the production native shell it substituted the fixture
// wave (`Bay B · Wave 3 · 06:40`), bay (`B-04`), route (`RT-2026-0502-A`)
// and cut-off (`07:30`) and presented them as LIVE loader-session data —
// a fixture masquerading as production data. Worse, the fabricated `bay`
// was fed into the REAL `induct_fieldops_parcel_v1` write as `p_bay`.
//
// These tests pin the honest-degrade contract: a real (all-null) resolver
// envelope in production must NOT yield the fixture wave/bay/route/cut-off
// or fixture counts; it must degrade to a neutral empty/zero state so the
// loader screen + app-bar render their honest empty states and the
// induction path never persists a fabricated bay.

import {
  buildNeutralFieldopsLoaderTodayEnvelope,
  mapFieldopsLoaderTodayEnvelope,
  resolveFieldopsInductionBay,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import type { MobileV2LoaderTodayEnvelope } from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import type {
  MobileV2LoaderDriverQueueEntry,
  MobileV2LoaderQuickAction,
} from "../../../apps/fieldops/src/mobile-v2-loader-today-screen";

// Quick-action tiles are a row-defined navigation surface (not tenant
// business data) — the resolver always returns them, and they are a
// legitimate fallback when the resolver omits the key.
const FIXTURE_QUICK_ACTIONS: ReadonlyArray<MobileV2LoaderQuickAction> = Object.freeze([
  Object.freeze({ id: "loader-scan" as const, icon: "scan" as const, label: "Scan-out", sub: "4 pending" }),
  Object.freeze({ id: "loader-manifest" as const, icon: "list" as const, label: "Manifest", sub: "9 parcels · 3 routes" }),
]);

// The fixture driver queue — fabricated business data. If the mapper ever
// leaks it behind a live resolver response, the assertions below catch it.
const FIXTURE_DRIVERS: ReadonlyArray<MobileV2LoaderDriverQueueEntry> = Object.freeze([
  Object.freeze({ name: "Omar Al-Saadi", route: "RT-2026-0502-A", pct: 88, status: "loading" as const }),
  Object.freeze({ name: "Rashid Hamad", route: "RT-2026-0502-B", pct: 42, status: "loading" as const }),
]);

// A representative preview fixture — mirrors MOBILE_V2_PREVIEW_LOADER_TODAY.
const FIXTURE: MobileV2LoaderTodayEnvelope = Object.freeze({
  greetingName: "Omar",
  activeOpsSessionId: "",
  waveLabel: "Bay B · Wave 3 · 06:40",
  bay: "B-04",
  routeLabel: "RT-2026-0502-A",
  cutOff: "07:30",
  coldChainCount: 3,
  liveRoutes: 3,
  totalParcels: 9,
  scannedParcels: 5,
  driversWaiting: 3,
  quickActions: FIXTURE_QUICK_ACTIONS,
  drivers: FIXTURE_DRIVERS,
});

// Representative envelope when no warehouse_scan ops_session is open: the
// caller's real greeting name + live route/parcel counts + driver queue,
// with honest NULL loader-wave assignment fields.
function realResolverEnvelope(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    greeting_name: "Layla",
    active_ops_session_id: null,
    wave_label: null,
    bay: null,
    route_label: null,
    cut_off: null,
    cold_chain_count: 2,
    live_routes: 4,
    total_parcels: 31,
    scanned_parcels: 12,
    drivers_waiting: 1,
    quick_actions: FIXTURE_QUICK_ACTIONS,
    drivers: [
      { name: "Khalid Otaibi", route: "RT-aabbccdd", pct: 50, status: "loading" },
    ],
    ...overrides,
  };
}

describe("mapFieldopsLoaderTodayEnvelope — E6 honest-degrade", () => {
  test("a real all-null-wave resolver envelope does NOT return the fixture wave assignment", () => {
    const mapped = mapFieldopsLoaderTodayEnvelope(realResolverEnvelope(), FIXTURE);
    // The core E6 assertion: resolver-NULL wave/bay/route/cut-off degrade
    // to neutral empty strings — never the fabricated fixture values.
    expect(mapped.activeOpsSessionId).toBe("");
    expect(mapped.waveLabel).toBe("");
    expect(mapped.waveLabel).not.toBe(FIXTURE.waveLabel);
    expect(mapped.bay).toBe("");
    expect(mapped.bay).not.toBe(FIXTURE.bay);
    expect(mapped.routeLabel).toBe("");
    expect(mapped.routeLabel).not.toBe(FIXTURE.routeLabel);
    expect(mapped.cutOff).toBe("");
    expect(mapped.cutOff).not.toBe(FIXTURE.cutOff);
  });

  test("a fabricated bay is never substituted — the induction write cannot persist a fixture bay", () => {
    const mapped = mapFieldopsLoaderTodayEnvelope(realResolverEnvelope(), FIXTURE);
    // `bay` is fed into induct_fieldops_parcel_v1 as p_bay. An empty
    // string makes the RPC honestly raise "requires bay" rather than
    // silently persisting the fixture "B-04" into a real induction.
    expect(mapped.bay).toBe("");
    expect(mapped.bay).not.toBe("B-04");
  });

  test("live counts pass through from the resolver, not the fixture", () => {
    const mapped = mapFieldopsLoaderTodayEnvelope(realResolverEnvelope(), FIXTURE);
    expect(mapped.coldChainCount).toBe(2);
    expect(mapped.liveRoutes).toBe(4);
    expect(mapped.totalParcels).toBe(31);
    expect(mapped.scannedParcels).toBe(12);
    expect(mapped.driversWaiting).toBe(1);
    // And they are NOT the fixture counts.
    expect(mapped.totalParcels).not.toBe(FIXTURE.totalParcels);
    expect(mapped.scannedParcels).not.toBe(FIXTURE.scannedParcels);
  });

  test("missing numeric counts degrade to zero, never fixture business numbers", () => {
    const mapped = mapFieldopsLoaderTodayEnvelope(
      realResolverEnvelope({
        cold_chain_count: null,
        live_routes: null,
        total_parcels: null,
        scanned_parcels: null,
        drivers_waiting: null,
      }),
      FIXTURE,
    );
    expect(mapped.coldChainCount).toBe(0);
    expect(mapped.liveRoutes).toBe(0);
    expect(mapped.totalParcels).toBe(0);
    expect(mapped.scannedParcels).toBe(0);
    expect(mapped.driversWaiting).toBe(0);
  });

  test("a real driver queue from the resolver is preserved verbatim", () => {
    const mapped = mapFieldopsLoaderTodayEnvelope(realResolverEnvelope(), FIXTURE);
    expect(mapped.drivers).toEqual([
      { name: "Khalid Otaibi", route: "RT-aabbccdd", pct: 50, status: "loading" },
    ]);
    expect(mapped.drivers).not.toEqual(FIXTURE_DRIVERS);
  });

  test("an absent `drivers` key degrades to [], never the fixture queue", () => {
    const mapped = mapFieldopsLoaderTodayEnvelope(
      realResolverEnvelope({ drivers: undefined }),
      FIXTURE,
    );
    expect(mapped.drivers).toEqual([]);
    expect(mapped.drivers).not.toBe(FIXTURE_DRIVERS);
  });

  test("an empty driver queue ([]) is a legitimate state and is preserved", () => {
    const mapped = mapFieldopsLoaderTodayEnvelope(
      realResolverEnvelope({ drivers: [] }),
      FIXTURE,
    );
    expect(mapped.drivers).toEqual([]);
  });

  test("identity greeting name resolves from the resolver, not the fixture", () => {
    const mapped = mapFieldopsLoaderTodayEnvelope(realResolverEnvelope(), FIXTURE);
    expect(mapped.greetingName).toBe("Layla");
    expect(mapped.greetingName).not.toBe(FIXTURE.greetingName);
  });

  test("a missing greeting_name degrades to empty string (not fixture name)", () => {
    const mapped = mapFieldopsLoaderTodayEnvelope(
      realResolverEnvelope({ greeting_name: null }),
      FIXTURE,
    );
    expect(mapped.greetingName).toBe("");
    expect(mapped.greetingName).not.toBe(FIXTURE.greetingName);
  });

  test("quick-action tiles are a row-defined navigation surface — fixture fallback only when omitted", () => {
    // Resolver returns the tiles → pass through.
    const withTiles = mapFieldopsLoaderTodayEnvelope(realResolverEnvelope(), FIXTURE);
    expect(withTiles.quickActions).toEqual(FIXTURE_QUICK_ACTIONS);
    // Resolver omits the key → keep the fixture's identical navigation
    // grid (these are route ids + labels, not tenant business data).
    const withoutTiles = mapFieldopsLoaderTodayEnvelope(
      realResolverEnvelope({ quick_actions: undefined }),
      FIXTURE,
    );
    expect(withoutTiles.quickActions).toBe(FIXTURE.quickActions);
  });
});

describe("mapFieldopsLoaderTodayEnvelope — real wave data passes through honestly", () => {
  test("a genuine wave assignment from the resolver is preserved verbatim", () => {
    const mapped = mapFieldopsLoaderTodayEnvelope(
      realResolverEnvelope({
        active_ops_session_id: "a1d18034-8e2f-4bb2-9ff9-cfd79eb58bf9",
        wave_label: "Bay C · Wave 7 · 09:10",
        bay: "C-12",
        route_label: "RT-2026-0610-X",
        cut_off: "09:45",
      }),
      FIXTURE,
    );
    // Real resolver fields pass through unchanged — and they are the
    // resolver's, not the fixture's.
    expect(mapped.activeOpsSessionId).toBe("a1d18034-8e2f-4bb2-9ff9-cfd79eb58bf9");
    expect(mapped.waveLabel).toBe("Bay C · Wave 7 · 09:10");
    expect(mapped.waveLabel).not.toBe(FIXTURE.waveLabel);
    expect(mapped.bay).toBe("C-12");
    expect(mapped.bay).not.toBe(FIXTURE.bay);
    expect(mapped.routeLabel).toBe("RT-2026-0610-X");
    expect(mapped.cutOff).toBe("09:45");
  });

  test("a null / non-object raw input degrades to a neutral envelope", () => {
    for (const raw of [null, undefined, 42, "oops"]) {
      const mapped = mapFieldopsLoaderTodayEnvelope(raw, FIXTURE);
      expect(mapped.greetingName).toBe("");
      expect(mapped.activeOpsSessionId).toBe("");
      expect(mapped.waveLabel).toBe("");
      expect(mapped.bay).toBe("");
      expect(mapped.routeLabel).toBe("");
      expect(mapped.cutOff).toBe("");
      expect(mapped.coldChainCount).toBe(0);
      expect(mapped.liveRoutes).toBe(0);
      expect(mapped.totalParcels).toBe(0);
      expect(mapped.scannedParcels).toBe(0);
      expect(mapped.driversWaiting).toBe(0);
      expect(mapped.drivers).toEqual([]);
      // Quick-action navigation tiles fall back from the fixture.
      expect(mapped.quickActions).toBe(FIXTURE.quickActions);
    }
  });

  test("the live missing-RPC fallback is neutral and cannot feed a fixture bay into writes", () => {
    const mapped = buildNeutralFieldopsLoaderTodayEnvelope(FIXTURE);
    expect(mapped.bay).toBe("");
    expect(mapped.waveLabel).toBe("");
    expect(mapped.routeLabel).toBe("");
    expect(mapped.cutOff).toBe("");
    expect(mapped.totalParcels).toBe(0);
    expect(mapped.scannedParcels).toBe(0);
    expect(mapped.drivers).toEqual([]);
    expect(resolveFieldopsInductionBay({ data: mapped })).toBe("");
    expect(mapped.bay).not.toBe(FIXTURE.bay);
  });

  test("the mapped envelope is frozen (immutable result contract)", () => {
    const mapped = mapFieldopsLoaderTodayEnvelope(realResolverEnvelope(), FIXTURE);
    expect(Object.isFrozen(mapped)).toBe(true);
  });
});

describe("resolveFieldopsInductionBay — E11 induction write-gate", () => {
  test("an in-flight / errored loader-today query (data undefined) yields an empty bay", () => {
    // The loader scan onSubmit blocks the induct_fieldops_parcel_v1 write
    // on `bay.length === 0`, so an unsettled or errored query must
    // resolve to "" — the fixture demo bay "B-04" is never written into
    // the real induction record + decision_log.
    expect(resolveFieldopsInductionBay({ data: undefined })).toBe("");
  });

  test("a settled envelope with a real resolver bay passes it through", () => {
    const settled = mapFieldopsLoaderTodayEnvelope(
      realResolverEnvelope({ bay: "A-12" }),
      FIXTURE,
    );
    expect(resolveFieldopsInductionBay({ data: settled })).toBe("A-12");
  });

  test("a settled envelope whose resolver omitted the bay yields '' — never the fixture bay", () => {
    const settled = mapFieldopsLoaderTodayEnvelope(realResolverEnvelope(), FIXTURE);
    expect(resolveFieldopsInductionBay({ data: settled })).toBe("");
    expect(resolveFieldopsInductionBay({ data: settled })).not.toBe("B-04");
  });
});
