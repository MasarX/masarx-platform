// #600: in live mode every FieldOps read shows loading, valid-empty or
// error, never fixture data. `fieldopsSurfaceQuery` is the one place that
// confines fixtures to showcase mode; the mappers reject malformed
// payloads so react-query reports an error. These tests pin each state for
// pickups, trips, wallet, cash drop and loader quick actions.

import {
  fieldopsSurfaceQuery,
  isMobileV2ListLoading,
  mapFieldopsCashDropEnvelope,
  mapFieldopsLoaderTodayEnvelope,
  mapFieldopsWalletEnvelope,
  buildNeutralFieldopsLoaderTodayEnvelope,
  parsePickupList,
  parseTripList,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import {
  MOBILE_V2_PREVIEW_CASH_DROP,
  MOBILE_V2_PREVIEW_LOADER_TODAY,
  MOBILE_V2_PREVIEW_PICKUPS,
  MOBILE_V2_PREVIEW_TRIPS,
  MOBILE_V2_PREVIEW_WALLET,
} from "../../../apps/fieldops/src/fixtures";

// Any non-null client means live mode; the reads below never touch it.
const LIVE_CLIENT = {} as unknown as NonNullable<Parameters<typeof fieldopsSurfaceQuery>[0]>;

interface Surface {
  readonly name: string;
  readonly fixture: unknown;
  readonly map: (raw: unknown) => unknown;
  readonly malformed: unknown;
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
