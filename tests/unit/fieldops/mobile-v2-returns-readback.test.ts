import {
  findMobileV2ReturnedStopAfterMark,
  mapFieldopsReturnsEnvelope,
  type MobileV2ReturnsEnvelope,
  type MobileV2WriteEnvelope,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";

const STOP_ID = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
const OTHER_STOP_ID = "22222222-2222-4222-8222-222222222222";
const DECISION_ID = "33333333-3333-4333-8333-333333333333";

const FALLBACK: MobileV2ReturnsEnvelope = Object.freeze({
  failed: Object.freeze([
    Object.freeze({
      id: "fixture-failed",
      seq: 1,
      customer: "Fixture Failed",
      addr: "Fixture Address",
      parcels: 1,
      failReason: "Fixture only",
    }),
  ]),
  returned: Object.freeze([
    Object.freeze({
      id: "fixture-returned",
      customer: "Fixture Returned",
      parcels: 1,
    }),
  ]),
  codCollected: 12,
  currency: "SAR",
});

describe("Mobile V2 returns backend readback parsing", () => {
  test("maps returned stop lineage from the backend resolver", () => {
    const mapped = mapFieldopsReturnsEnvelope(
      {
        failed: [
          {
            id: OTHER_STOP_ID,
            seq: 4,
            customer: "Failed Customer",
            addr: "District 4",
            parcels: 3,
            fail_reason: "Customer refused",
          },
        ],
        returned: [
          {
            id: "RTO-11111111",
            stop_id: STOP_ID,
            customer: "Returned Customer",
            parcels: 2,
          },
        ],
        cod_collected_sar: 0,
        currency: "SAR",
      },
      FALLBACK,
    );

    expect(mapped.failed).toEqual([
      {
        id: OTHER_STOP_ID,
        seq: 4,
        customer: "Failed Customer",
        addr: "District 4",
        parcels: 3,
        failReason: "Customer refused",
      },
    ]);
    expect(mapped.returned).toEqual([
      {
        id: "RTO-11111111",
        stopId: STOP_ID,
        customer: "Returned Customer",
        parcels: 2,
      },
    ]);
    expect(mapped.codCollected).toBe(0);
  });

  test("preserves honest empty backend arrays instead of repopulating fixtures", () => {
    const mapped = mapFieldopsReturnsEnvelope(
      {
        failed: [],
        returned: [],
        cod_collected_sar: 0,
      },
      FALLBACK,
    );

    expect(mapped.failed).toEqual([]);
    expect(mapped.returned).toEqual([]);
    expect(mapped.codCollected).toBe(0);
  });

  test("matches the marked-returned write only after backend resolver returns the same stop", () => {
    const write: MobileV2WriteEnvelope = {
      ok: true,
      decision_log_id: DECISION_ID,
      state: "rto",
      stop_id: STOP_ID,
    };

    expect(
      findMobileV2ReturnedStopAfterMark(
        [
          {
            id: "RTO-22222222",
            stopId: OTHER_STOP_ID,
            customer: "Other",
            parcels: 1,
          },
          {
            id: "RTO-11111111",
            stopId: STOP_ID,
            customer: "Returned Customer",
            parcels: 2,
          },
        ],
        write,
        STOP_ID,
      ),
    ).toMatchObject({
      id: "RTO-11111111",
      stopId: STOP_ID,
    });

    expect(
      findMobileV2ReturnedStopAfterMark(
        [
          {
            id: "RTO-11111111",
            stopId: STOP_ID,
            customer: "Returned Customer",
            parcels: 2,
          },
        ],
        { ...write, stop_id: OTHER_STOP_ID },
        STOP_ID,
      ),
    ).toBeNull();
  });
});
