// Unit coverage for `mapFieldopsRiderTodayEnvelope` — the pure mapper
// behind `useFieldopsRiderTodayRpc`.
//
// Engineering re-audit E5 (hidden mock): `resolve_fieldops_rider_today_v1`
// ALWAYS returns `active: NULL` / `online: NULL` / `rating: NULL` /
// `shift_duration: NULL` because rider gig tickets + per-shift earnings
// have no canonical source table yet (by design). The previous per-field
// mapper fell each missing field through to the typed fixture value, so
// in the production native shell it unconditionally substituted the
// fixture ticket (TK-7741 / Najd Coffee / +18 ﷼) and presented it as a
// LIVE delivery — a fixture masquerading as production data.
//
// These tests pin the honest-degrade contract: a real (all-null) resolver
// envelope in production must NOT yield the fixture ticket or fixture
// business numbers; it must degrade to a neutral empty/zero state so the
// rider screen renders its honest "No active ticket" empty state.

import { mapFieldopsRiderTodayEnvelope } from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import type {
  MobileV2RiderTodayEnvelope,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import type { MobileV2RiderTicket } from "../../../apps/fieldops/src/mobile-v2-rider-today-screen";

// A representative preview fixture — mirrors MOBILE_V2_PREVIEW_RIDER_TODAY.
// If the mapper ever leaks fixture business data behind a live resolver
// response, the assertions below catch it by comparing against these
// exact fabricated values.
const FIXTURE_TICKET: MobileV2RiderTicket = Object.freeze({
  id: "TK-7741",
  kind: "food",
  vendor: "Najd Coffee",
  pickup: "Olaya Mall G-12",
  drop: "Wurud · 226",
  payout: 18,
  etaMin: 8,
  status: "active",
  cod: 0,
});

const FIXTURE_UPCOMING: ReadonlyArray<MobileV2RiderTicket> = Object.freeze([
  Object.freeze({
    id: "TK-7742",
    kind: "pharmacy" as const,
    vendor: "Tahani RX",
    pickup: "Al Olaya 7821",
    drop: "Murooj 4419",
    payout: 24,
    etaMin: 14,
    status: "queued" as const,
    cod: 120,
  }),
]);

const FIXTURE: MobileV2RiderTodayEnvelope = Object.freeze({
  greetingName: "Omar",
  employeeId: "DRV-2041",
  online: true,
  earningsToday: 184,
  tripsCompleted: 12,
  rating: 4.9,
  shiftDuration: "5h 12m",
  currency: "SAR",
  active: FIXTURE_TICKET,
  upcoming: FIXTURE_UPCOMING,
});

// The envelope `resolve_fieldops_rider_today_v1` actually returns today:
// the caller's real greeting name + an honest empty/zero gig state.
function realResolverEnvelope(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    greeting_name: "Layla",
    employee_id: null,
    online: null,
    earnings_today: 0,
    trips_completed: 0,
    rating: null,
    shift_duration: null,
    currency: null,
    active: null,
    upcoming: [],
    ...overrides,
  };
}

describe("mapFieldopsRiderTodayEnvelope — E5 honest-degrade", () => {
  test("a real all-null resolver envelope does NOT return the fixture ticket", () => {
    const mapped = mapFieldopsRiderTodayEnvelope(realResolverEnvelope(), FIXTURE);
    // The core E5 assertion: `active` stays null — the rider screen then
    // renders its honest "No active ticket" empty state.
    expect(mapped.active).toBeNull();
    // And it must NOT be the fabricated fixture ticket.
    expect(mapped.active).not.toBe(FIXTURE_TICKET);
    expect(mapped.active).not.toEqual(FIXTURE_TICKET);
  });

  test("guaranteed-null gig fields degrade to neutral values, not fixture business data", () => {
    const mapped = mapFieldopsRiderTodayEnvelope(realResolverEnvelope(), FIXTURE);
    // online / rating / shiftDuration are NULL from the resolver — they
    // must NOT inherit the fixture's true / 4.9 / "5h 12m".
    expect(mapped.online).toBe(false);
    expect(mapped.online).not.toBe(FIXTURE.online);
    expect(mapped.rating).toBe(0);
    expect(mapped.rating).not.toBe(FIXTURE.rating);
    expect(mapped.shiftDuration).toBe("");
    expect(mapped.shiftDuration).not.toBe(FIXTURE.shiftDuration);
  });

  test("zero earnings / trips pass through as zero (not fixture 184 / 12)", () => {
    const mapped = mapFieldopsRiderTodayEnvelope(realResolverEnvelope(), FIXTURE);
    expect(mapped.earningsToday).toBe(0);
    expect(mapped.earningsToday).not.toBe(FIXTURE.earningsToday);
    expect(mapped.tripsCompleted).toBe(0);
    expect(mapped.tripsCompleted).not.toBe(FIXTURE.tripsCompleted);
  });

  test("an absent `upcoming` key degrades to [], never the fixture queue", () => {
    const mapped = mapFieldopsRiderTodayEnvelope(realResolverEnvelope(), FIXTURE);
    expect(mapped.upcoming).toEqual([]);
    expect(mapped.upcoming).not.toBe(FIXTURE_UPCOMING);
  });

  test("identity fields resolve from the resolver, not the fixture", () => {
    const mapped = mapFieldopsRiderTodayEnvelope(realResolverEnvelope(), FIXTURE);
    // greeting_name is real → pass through.
    expect(mapped.greetingName).toBe("Layla");
    // employee_id is NULL today → neutral empty string, NOT fixture id.
    expect(mapped.employeeId).toBe("");
    expect(mapped.employeeId).not.toBe(FIXTURE.employeeId);
  });

  test("a missing greeting_name degrades to empty string (not fixture name)", () => {
    const mapped = mapFieldopsRiderTodayEnvelope(
      realResolverEnvelope({ greeting_name: null }),
      FIXTURE,
    );
    expect(mapped.greetingName).toBe("");
    expect(mapped.greetingName).not.toBe(FIXTURE.greetingName);
  });

  test("currency is a cosmetic locale label — keeps the fallback when null", () => {
    const mapped = mapFieldopsRiderTodayEnvelope(realResolverEnvelope(), FIXTURE);
    // currency drives only the ﷼ symbol; a non-empty fallback is
    // defensible so the earnings figure still renders a unit.
    expect(mapped.currency).toBe(FIXTURE.currency);
  });
});

describe("mapFieldopsRiderTodayEnvelope — real data passes through honestly", () => {
  test("a genuine active ticket from the resolver is preserved verbatim", () => {
    const liveTicket = {
      id: "TK-9001",
      kind: "parcel",
      vendor: "MasarX SDD",
      pickup: "HUB-RYD-02",
      drop: "Al Nakheel",
      payout: 41,
      etaMin: 19,
      status: "active",
      cod: 0,
    };
    const mapped = mapFieldopsRiderTodayEnvelope(
      realResolverEnvelope({
        active: liveTicket,
        online: true,
        rating: 4.7,
        shift_duration: "3h 04m",
        earnings_today: 96,
        trips_completed: 5,
      }),
      FIXTURE,
    );
    // Real resolver fields pass through unchanged — and the ticket is
    // the resolver's, not the fixture's.
    expect(mapped.active).toEqual(liveTicket);
    expect(mapped.active).not.toEqual(FIXTURE_TICKET);
    expect(mapped.online).toBe(true);
    expect(mapped.rating).toBe(4.7);
    expect(mapped.shiftDuration).toBe("3h 04m");
    expect(mapped.earningsToday).toBe(96);
    expect(mapped.tripsCompleted).toBe(5);
  });

  test("a real `upcoming` list from the resolver is preserved verbatim", () => {
    const liveUpcoming = [
      {
        id: "TK-9002",
        kind: "food",
        vendor: "Hadramout",
        pickup: "Tahlia 12",
        drop: "Sahafa 88",
        payout: 22,
        etaMin: 11,
        status: "queued",
        cod: 0,
      },
    ];
    const mapped = mapFieldopsRiderTodayEnvelope(
      realResolverEnvelope({ upcoming: liveUpcoming }),
      FIXTURE,
    );
    expect(mapped.upcoming).toEqual(liveUpcoming);
    expect(mapped.upcoming).not.toEqual(FIXTURE_UPCOMING);
  });

  test("a null / non-object raw input degrades to a neutral envelope", () => {
    for (const raw of [null, undefined, 42, "oops"]) {
      const mapped = mapFieldopsRiderTodayEnvelope(raw, FIXTURE);
      expect(mapped.active).toBeNull();
      expect(mapped.online).toBe(false);
      expect(mapped.earningsToday).toBe(0);
      expect(mapped.tripsCompleted).toBe(0);
      expect(mapped.greetingName).toBe("");
      expect(mapped.upcoming).toEqual([]);
      // Only the cosmetic currency label survives from the fallback.
      expect(mapped.currency).toBe(FIXTURE.currency);
    }
  });

  test("the mapped envelope is frozen (immutable result contract)", () => {
    const mapped = mapFieldopsRiderTodayEnvelope(realResolverEnvelope(), FIXTURE);
    expect(Object.isFrozen(mapped)).toBe(true);
  });
});
