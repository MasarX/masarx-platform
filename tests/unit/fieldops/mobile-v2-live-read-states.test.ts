// #600: in live mode every FieldOps read shows loading, valid-empty or
// error, never fixture data. `fieldopsSurfaceQuery` is the one place that
// confines fixtures to showcase mode; the mappers reject malformed
// payloads so react-query reports an error. These tests pin each state for
// every FieldOps read surface, the loader quick actions and the cash drop
// access-denied state.

import {
  fieldopsSurfaceQuery,
  isMobileV2ListLoading,
  mapFieldopsCashDropEnvelope,
  mapFieldopsLoaderTodayEnvelope,
  mapFieldopsLookupEnvelope,
  mapFieldopsReturnsEnvelope,
  mapFieldopsSortationEnvelope,
  mapFieldopsSupervisorQueueEnvelope,
  mapFieldopsWalletEnvelope,
  buildNeutralFieldopsLoaderTodayEnvelope,
  parseHoldList,
  parseHubPickupList,
  parsePickupList,
  parseTripList,
  readFieldopsRiderTodayPayload,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import { isMobileV2CashDropTabDenied } from "../../../apps/fieldops/src/mobile-v2-navigation";
import {
  MOBILE_V2_PREVIEW_CASH_DROP,
  MOBILE_V2_PREVIEW_HUB_PICKUP,
  MOBILE_V2_PREVIEW_LOADER_TODAY,
  MOBILE_V2_PREVIEW_LOOKUP_RECORDS,
  MOBILE_V2_PREVIEW_PICKUPS,
  MOBILE_V2_PREVIEW_RETURNS,
  MOBILE_V2_PREVIEW_RIDER_TODAY,
  MOBILE_V2_PREVIEW_SORTATION_BAYS,
  MOBILE_V2_PREVIEW_SORTATION_RECENT,
  MOBILE_V2_PREVIEW_SUPERVISOR_QUEUE,
  MOBILE_V2_PREVIEW_TRIPS,
  MOBILE_V2_PREVIEW_WALLET,
  buildMobileV2PreviewHold,
  buildMobileV2PreviewLookupRecent,
} from "../../../apps/fieldops/src/fixtures";

// Any non-null client means live mode; the reads below never touch it.
const LIVE_CLIENT = {} as unknown as NonNullable<Parameters<typeof fieldopsSurfaceQuery>[0]>;

interface Surface {
  readonly name: string;
  readonly fixture: unknown;
  readonly map: (raw: unknown) => unknown;
  readonly malformed: unknown;
  /** A valid empty resolver payload; it maps to empty lists and zeros. */
  readonly empty?: unknown;
}

const SURFACES: ReadonlyArray<Surface> = [
  { name: "pickups", fixture: MOBILE_V2_PREVIEW_PICKUPS, map: (raw) => parsePickupList(raw), malformed: { rows: [] } },
  { name: "trips", fixture: MOBILE_V2_PREVIEW_TRIPS, map: (raw) => parseTripList(raw), malformed: "bad" },
  { name: "wallet", fixture: MOBILE_V2_PREVIEW_WALLET, map: (raw) => mapFieldopsWalletEnvelope(raw), malformed: { wallet: null } },
  {
    name: "cash drop",
    fixture: MOBILE_V2_PREVIEW_CASH_DROP,
    map: (raw) => mapFieldopsCashDropEnvelope(raw),
    malformed: { expected_sar: "lots", safe_location: 7 },
  },
  {
    name: "sortation",
    fixture: {
      bays: MOBILE_V2_PREVIEW_SORTATION_BAYS,
      recent: MOBILE_V2_PREVIEW_SORTATION_RECENT,
      inductedThisSession: 677,
      throughputPerHour: 146,
      minutesElapsed: 278,
    },
    map: (raw) => mapFieldopsSortationEnvelope(raw),
    malformed: { bays: [], recent: [] },
    empty: { bays: [], recent: [], inducted: 0, throughput_per_hour: 0, minutes_elapsed: 0 },
  },
  {
    name: "lookup",
    fixture: { records: MOBILE_V2_PREVIEW_LOOKUP_RECORDS, recent: buildMobileV2PreviewLookupRecent() },
    map: (raw) => mapFieldopsLookupEnvelope(raw),
    malformed: { records: null, recent: [] },
    empty: { records: [], recent: [] },
  },
  {
    name: "returns",
    fixture: MOBILE_V2_PREVIEW_RETURNS,
    map: (raw) => mapFieldopsReturnsEnvelope(raw),
    malformed: { failed: "none", returned: [], cod_collected_sar: 0 },
    empty: { failed: [], returned: [], cod_collected_sar: 0 },
  },
  {
    name: "hub pickup",
    fixture: MOBILE_V2_PREVIEW_HUB_PICKUP,
    map: (raw) => parseHubPickupList(raw),
    malformed: { rows: [] },
    empty: [],
  },
  {
    name: "hold",
    fixture: buildMobileV2PreviewHold(),
    map: (raw) => parseHoldList(raw),
    malformed: [{ parcel: 7 }],
    empty: [],
  },
  {
    name: "rider today",
    fixture: MOBILE_V2_PREVIEW_RIDER_TODAY,
    map: (raw) => readFieldopsRiderTodayPayload(raw, MOBILE_V2_PREVIEW_RIDER_TODAY),
    malformed: 42,
    empty: { greeting_name: null, employee_id: null, active: null, upcoming: [] },
  },
  {
    name: "supervisor queue",
    fixture: MOBILE_V2_PREVIEW_SUPERVISOR_QUEUE,
    map: (raw) => mapFieldopsSupervisorQueueEnvelope(raw),
    malformed: { supervisor_name: "Lead", queue: null },
    empty: { supervisor_name: null, queue: [], active_id: null },
  },
];

describe.each(SURFACES)("FieldOps $name read states (#600)", (surface) => {
  test("live loading: no fixture is seeded, so the loading state shows", () => {
    const query = fieldopsSurfaceQuery(LIVE_CLIENT, surface.fixture, async () => surface.fixture);
    expect(query.initialData).toBeUndefined();
    expect(isMobileV2ListLoading({ isLoading: true, data: query.initialData })).toBe(true);
  });

  test("live failed read: the query rejects, so the error state shows", async () => {
    const query = fieldopsSurfaceQuery(LIVE_CLIENT, surface.fixture, async () => {
      throw new Error("mobile_v2_rpc:failed");
    });
    await expect(query.queryFn()).rejects.toThrow("mobile_v2_rpc:failed");
  });

  test("live malformed payload: the query rejects, never resolving to the fixture", async () => {
    const query = fieldopsSurfaceQuery(LIVE_CLIENT, surface.fixture, async () => surface.map(surface.malformed));
    await expect(query.queryFn()).rejects.toThrow(/malformed payload/);
  });

  test("showcase: the fixture renders without a live read", async () => {
    const readLive = jest.fn(async () => surface.map(surface.malformed));
    const query = fieldopsSurfaceQuery(null, surface.fixture, readLive);
    expect(query.initialData).toBe(surface.fixture);
    await expect(query.queryFn()).resolves.toBe(surface.fixture);
    expect(readLive).not.toHaveBeenCalled();
  });
});

// Every list in a valid empty payload maps to [] and every number to 0.
function expectNoFixtureValues(value: unknown): void {
  if (Array.isArray(value)) {
    expect(value).toEqual([]);
  } else if (typeof value === "number") {
    expect(value).toBe(0);
  } else if (value !== null && typeof value === "object") {
    for (const field of Object.values(value)) expectNoFixtureValues(field);
  }
}

describe.each(SURFACES.filter((surface) => surface.empty !== undefined))(
  "FieldOps $name valid-empty live read (#600)",
  (surface) => {
    test("an empty resolver payload renders empty, never fixture rows", async () => {
      const query = fieldopsSurfaceQuery(LIVE_CLIENT, surface.fixture, async () => surface.map(surface.empty));
      const data = await query.queryFn();
      expect(data).not.toBe(surface.fixture);
      expectNoFixtureValues(data);
    });
  },
);

describe("FieldOps cash drop access denied (#600)", () => {
  test("a live user without cash_drop.write gets the denied state on cash drop and COD ledger", () => {
    expect(isMobileV2CashDropTabDenied("mobile-cash-drop", false)).toBe(true);
    expect(isMobileV2CashDropTabDenied("mobile-cod-ledger", false)).toBe(true);
  });

  test("the capability, or another surface, is never denied", () => {
    expect(isMobileV2CashDropTabDenied("mobile-cash-drop", true)).toBe(false);
    expect(isMobileV2CashDropTabDenied("mobile-cod-ledger", true)).toBe(false);
    expect(isMobileV2CashDropTabDenied("mobile-wallet", false)).toBe(false);
  });
});

describe("FieldOps valid-empty live reads (#600)", () => {
  test("empty pickups and trips are a real empty list", async () => {
    await expect(fieldopsSurfaceQuery(LIVE_CLIENT, MOBILE_V2_PREVIEW_PICKUPS, async () => parsePickupList([])).queryFn()).resolves.toEqual([]);
    await expect(fieldopsSurfaceQuery(LIVE_CLIENT, MOBILE_V2_PREVIEW_TRIPS, async () => parseTripList([])).queryFn()).resolves.toEqual([]);
  });

  test("an empty wallet and cash drop show zero, not fixture amounts", () => {
    const wallet = mapFieldopsWalletEnvelope({
      wallet: { balance_sar: 0, week_to_date_sar: 0, posts_to_bank_label: "" },
      week: [],
      breakdown: [],
    });
    expect(wallet.wallet.balanceSar).toBe(0);
    expect(wallet.week).toEqual([]);
    const cashDrop = mapFieldopsCashDropEnvelope({ expected_sar: 0, safe_location: "" });
    expect(cashDrop.expectedSar).toBe(0);
    expect(cashDrop.lastDrop).toBeNull();
  });
});

describe("FieldOps loader quick actions (#600 Design decision)", () => {
  const fixture = MOBILE_V2_PREVIEW_LOADER_TODAY;
  const envelope = (quickActions: unknown) => ({ wave_label: null, bay: null, quick_actions: quickActions });

  test("live missing or malformed tiles give the error state (null), never fixture tiles", () => {
    expect(mapFieldopsLoaderTodayEnvelope(envelope(undefined), fixture).quickActions).toBeNull();
    expect(mapFieldopsLoaderTodayEnvelope(envelope("bad"), fixture).quickActions).toBeNull();
  });

  test("live loading or missing resolver gives the error state, never fixture tiles", () => {
    expect(buildNeutralFieldopsLoaderTodayEnvelope(fixture).quickActions).toBeNull();
    const query = fieldopsSurfaceQuery(LIVE_CLIENT, fixture, async () => fixture);
    expect(query.initialData).toBeUndefined();
  });

  test("live failed read rejects, so the screen shows its error state", async () => {
    const query = fieldopsSurfaceQuery(LIVE_CLIENT, fixture, async () => {
      throw new Error("mobile_v2_rpc:failed");
    });
    await expect(query.queryFn()).rejects.toThrow("mobile_v2_rpc:failed");
  });

  test("a valid empty tile list stays empty, which hides the row", () => {
    expect(mapFieldopsLoaderTodayEnvelope(envelope([]), fixture).quickActions).toEqual([]);
  });

  test("showcase renders the fixture tiles", async () => {
    const query = fieldopsSurfaceQuery(null, fixture, async () => mapFieldopsLoaderTodayEnvelope(envelope(undefined), fixture));
    expect(query.initialData?.quickActions).toBe(fixture.quickActions);
    expect(fixture.quickActions?.length ?? 0).toBeGreaterThan(0);
  });
});
