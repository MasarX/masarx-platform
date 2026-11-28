// #600 slice 3: the profile, route and incident-type reads, and the
// capability-gated tabs, show loading, valid-empty or error in live mode,
// never fixture data or a denied flash. Same pattern as
// mobile-v2-live-read-states.test.ts: `fieldopsSurfaceQuery` confines
// fixtures to showcase mode, and the mappers reject malformed payloads.

import {
  fieldopsSurfaceQuery,
  isMobileV2ListLoading,
  mapFieldopsIncidentTypesPayload,
  mapFieldopsProfileEnvelope,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import { resolveMobileV2GatedTabAccess } from "../../../apps/fieldops/src/mobile-v2-navigation";
import {
  MOBILE_V2_PREVIEW_INCIDENT_TYPES,
  MOBILE_V2_PREVIEW_ROUTE,
  MOBILE_V2_PREVIEW_USER,
} from "../../../apps/fieldops/src/fixtures";

// Any non-null client means live mode; the reads below never touch it.
const LIVE_CLIENT = {} as unknown as NonNullable<Parameters<typeof fieldopsSurfaceQuery>[0]>;

const ROUTE_FIXTURE = Object.freeze({
  rows: MOBILE_V2_PREVIEW_ROUTE.rows,
  totalStops: MOBILE_V2_PREVIEW_ROUTE.totalStops,
  routeId: MOBILE_V2_PREVIEW_ROUTE.mapRouteId,
  routeRunId: null,
  manifestSummary: null,
});

interface Surface {
  readonly name: string;
  readonly fixture: unknown;
  readonly map: (raw: unknown) => unknown;
  readonly malformed: ReadonlyArray<unknown>;
}

const SURFACES: ReadonlyArray<Surface> = [
  {
    name: "profile",
    fixture: MOBILE_V2_PREVIEW_USER,
    map: (raw) => mapFieldopsProfileEnvelope(raw),
    malformed: [42, null, [], { name: 7, badge: "B" }, { name: "N", badge: false }],
  },
  {
    name: "incident types",
    fixture: MOBILE_V2_PREVIEW_INCIDENT_TYPES,
    map: (raw) => mapFieldopsIncidentTypesPayload(raw),
    malformed: ["bad", [7], { value: "x" }, { value: { types: "x" } }, { value: [{ label: "no id" }] }],
  },
  {
    name: "route",
    fixture: ROUTE_FIXTURE,
    map: (raw) => raw,
    malformed: [],
  },
];

describe.each(SURFACES)("FieldOps $name read states (#600 slice 3)", (surface) => {
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

  test("live malformed payloads: the query rejects, never resolving to the fixture", async () => {
    for (const raw of surface.malformed) {
      const query = fieldopsSurfaceQuery(LIVE_CLIENT, surface.fixture, async () => surface.map(raw));
      await expect(query.queryFn()).rejects.toThrow(/malformed payload/);
    }
  });

  test("showcase: the fixture renders without a live read", async () => {
    const readLive = jest.fn(async () => surface.map(undefined));
    const query = fieldopsSurfaceQuery(null, surface.fixture, readLive);
    expect(query.initialData).toBe(surface.fixture);
    await expect(query.queryFn()).resolves.toBe(surface.fixture);
    expect(readLive).not.toHaveBeenCalled();
  });
});

describe("FieldOps profile live mapping (#600 slice 3)", () => {
  test("NULL name and badge stay empty, never the demo identity", () => {
    const profile = mapFieldopsProfileEnvelope({ name: null, badge: null });
    expect(profile).toEqual({ name: "", badge: "" });
    expect(profile.name).not.toBe(MOBILE_V2_PREVIEW_USER.name);
  });

  test("a missing currency is not filled from the fixture", () => {
    const profile = mapFieldopsProfileEnvelope({ name: "Driver", badge: "B-1" });
    expect(profile).toEqual({ name: "Driver", badge: "B-1" });
    expect(profile.currency).toBeUndefined();
  });

  test("resolver values pass through", () => {
    expect(mapFieldopsProfileEnvelope({ name: "Driver", badge: "B-1", currency: "AED" })).toEqual({
      name: "Driver",
      badge: "B-1",
      currency: "AED",
    });
  });
});

describe("FieldOps incident types live mapping (#600 slice 3)", () => {
  test.each([null, [], [null], { value: null }, { value: [] }, { value: { types: [] } }])(
    "valid-empty payload %j renders no types, never the demo list",
    (raw) => {
      expect(mapFieldopsIncidentTypesPayload(raw)).toEqual([]);
    },
  );

  test("resolver rows pass through", () => {
    const types = mapFieldopsIncidentTypesPayload([
      { value: { types: [{ id: "collision", label: "Collision", icon: "alert", severity: "high", needs: [] }] } },
    ]);
    expect(types.map((t) => t.id)).toEqual(["collision"]);
  });
});

describe("FieldOps gated tab access (#600 slice 3)", () => {
  const settled = { navigationSettled: true, cashDropAccessEnabled: true, walletAccessEnabled: true };

  test("wallet without wallet.read shows the denied state once navigation settles", () => {
    expect(resolveMobileV2GatedTabAccess("mobile-wallet", { ...settled, walletAccessEnabled: false })).toBe("denied");
    expect(resolveMobileV2GatedTabAccess("mobile-wallet", settled)).toBe("allowed");
  });

  test.each(["mobile-cash-drop", "mobile-cod-ledger", "mobile-wallet"])(
    "%s shows the navigation read state, not a denied flash, until navigation settles",
    (tabId) => {
      const unsettled = { navigationSettled: false, cashDropAccessEnabled: false, walletAccessEnabled: false };
      expect(resolveMobileV2GatedTabAccess(tabId, unsettled)).toBe("pending");
      expect(resolveMobileV2GatedTabAccess(tabId, { ...unsettled, navigationSettled: true })).toBe("denied");
    },
  );

  test("cash drop and COD ledger are allowed with cash_drop.write", () => {
    expect(resolveMobileV2GatedTabAccess("mobile-cash-drop", settled)).toBe("allowed");
    expect(resolveMobileV2GatedTabAccess("mobile-cod-ledger", settled)).toBe("allowed");
  });

  test("ungated tabs are always allowed", () => {
    const none = { navigationSettled: false, cashDropAccessEnabled: false, walletAccessEnabled: false };
    expect(resolveMobileV2GatedTabAccess("mobile-tasks", none)).toBe("allowed");
  });
});
