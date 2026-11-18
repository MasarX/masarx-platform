import {
  parseTripList,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import {
  refreshMobileV2PodReadback,
} from "../../../apps/fieldops/src/mobile-v2-pod-readback";
import {
  mobileV2TripsHaveStage,
} from "../../../apps/fieldops/src/mobile-v2-trip-readback";
import type {
  MobileV2Trip,
} from "../../../apps/fieldops/src/mobile-v2-trips-screen";

const TRIP_ID = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";

const FALLBACK_TRIP: MobileV2Trip = Object.freeze({
  id: "fallback",
  leg: "Fallback origin -> Fallback dest",
  driver: "Fallback driver",
  vehicle: "Fallback vehicle",
  stage: "assigned",
  origin: Object.freeze({ id: "OR-FB", name: "Fallback origin" }),
  dest: Object.freeze({ id: "DE-FB", name: "Fallback dest" }),
  plannedDepart: "",
  plannedArrive: "",
  etaMin: null,
  distance: 0,
  totalParcels: 0,
  scanned: 0,
  sealNo: null,
  manifest: Object.freeze([]),
});

describe("Mobile V2 trip stage readback", () => {
  test("matches the backend-refetched trip stage by canonical trip id", () => {
    expect(
      mobileV2TripsHaveStage([
        { id: "other", stage: "arrived" },
        { id: TRIP_ID, stage: "gate-in" },
      ], TRIP_ID, "gate-in"),
    ).toBe(true);

    expect(
      mobileV2TripsHaveStage([
        { id: TRIP_ID, stage: "assigned" },
      ], TRIP_ID, "gate-in"),
    ).toBe(false);
  });

  test("parses resolver stage readback without substituting fixture stage", () => {
    const rows = parseTripList([
      {
        id: TRIP_ID,
        origin: { id: "RUH", name: "Riyadh Hub" },
        dest: { id: "JED", name: "Jeddah Hub" },
        stage: "arrived",
        plannedDepart: "09:00",
        plannedArrive: "14:00",
        distance: 842,
        totalParcels: 42,
        scanned: 42,
      },
    ], [FALLBACK_TRIP]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: TRIP_ID,
      stage: "arrived",
      origin: { id: "RUH", name: "Riyadh Hub" },
      dest: { id: "JED", name: "Jeddah Hub" },
      totalParcels: 42,
      scanned: 42,
    });
  });

  test("treats empty trip resolver arrays as a real empty state", () => {
    expect(parseTripList([], [FALLBACK_TRIP])).toEqual([]);
  });

  test("waits for backend-refetched trip stage before accepting visible success", async () => {
    let calls = 0;

    await expect(
      refreshMobileV2PodReadback([
        {
          label: "trips",
          refetch: async () => {
            calls += 1;
            return {
              isError: false,
              data: [
                {
                  id: TRIP_ID,
                  stage: calls >= 2 ? "sealed" : "loading",
                },
              ],
            };
          },
          expect: (data) => mobileV2TripsHaveStage(data, TRIP_ID, "sealed"),
        },
      ], { attempts: 3, delayMs: 0 }),
    ).resolves.toEqual({ ok: true, failedLabels: [] });

    expect(calls).toBe(2);
  });
});
