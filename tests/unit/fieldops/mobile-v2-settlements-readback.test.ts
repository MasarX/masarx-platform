import {
  EMPTY_FIELDOPS_SETTLEMENTS_ENVELOPE,
  mapFieldopsSettlementsEnvelope,
  resolveFieldopsSettlementsDisplayEnvelope,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import {
  type MobileV2SettlementLedgerEnvelope,
} from "../../../apps/fieldops/src/mobile-v2-settlements-screen";

describe("mapFieldopsSettlementsEnvelope", () => {
  it("maps backend settlement rows and summary without fixture substitution", () => {
    const mapped = mapFieldopsSettlementsEnvelope({
      settlements: [
        {
          id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
          title: "Driver shift settlement",
          kind: "cod",
          scope_type: "driver_shift",
          status: "locked",
          expected_amount: "1200",
          collected_amount: 1190,
          remitted_amount: 1185,
          variance_amount: -10,
          currency: "SAR",
          window_label: "May 29 shift",
          updated_at: "2026-05-29T08:00:00.000Z",
        },
      ],
      summary: {
        count: 1,
        expected_amount: 1200,
        collected_amount: 1190,
        remitted_amount: 1185,
        variance_amount: -10,
        currency: "SAR",
      },
      readback: {
        source: "resolve_fieldops_settlements_v1",
        count: 1,
        resolved_at: "2026-05-29T08:01:00.000Z",
      },
    });

    expect(mapped.settlements).toHaveLength(1);
    expect(mapped.settlements[0]).toMatchObject({
      id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
      title: "Driver shift settlement",
      kind: "cod",
      scopeType: "driver_shift",
      status: "locked",
      expectedAmount: 1200,
      collectedAmount: 1190,
      remittedAmount: 1185,
      varianceAmount: -10,
      currency: "SAR",
    });
    expect(mapped.summary).toMatchObject({
      count: 1,
      expectedAmount: 1200,
      collectedAmount: 1190,
      remittedAmount: 1185,
      varianceAmount: -10,
    });
    expect(mapped.readback).toEqual({
      source: "resolve_fieldops_settlements_v1",
      count: 1,
      resolvedAt: "2026-05-29T08:01:00.000Z",
    });
  });

  it("keeps a real empty backend list empty", () => {
    const mapped = mapFieldopsSettlementsEnvelope({
      settlements: [],
      summary: { count: 0 },
      readback: {
        source: "resolve_fieldops_settlements_v1",
        count: 0,
        resolved_at: "2026-05-29T08:02:00.000Z",
      },
    });

    expect(mapped.settlements).toEqual([]);
    expect(mapped.summary.count).toBe(0);
    expect(mapped.readback.count).toBe(0);
  });

  it("derives summary totals from rows when the backend omits summary fields", () => {
    const mapped = mapFieldopsSettlementsEnvelope({
      settlements: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          kind: "cod",
          status: "approved",
          expected_amount: 300,
          collected_amount: 300,
          remitted_amount: 300,
          currency: "SAR",
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          kind: "cod",
          status: "locked",
          expected_amount: 200,
          collected_amount: 195,
          remitted_amount: 195,
          currency: "SAR",
        },
      ],
      readback: {},
    });

    expect(mapped.summary).toMatchObject({
      count: 2,
      expectedAmount: 500,
      collectedAmount: 495,
      remittedAmount: 495,
      varianceAmount: -5,
      currency: "SAR",
    });
  });

  it("degrades malformed payloads to the neutral empty envelope", () => {
    const mapped = mapFieldopsSettlementsEnvelope(null);
    expect(mapped).toEqual(EMPTY_FIELDOPS_SETTLEMENTS_ENVELOPE);
  });

  it("filters malformed settlement rows instead of inventing identifiers", () => {
    const mapped = mapFieldopsSettlementsEnvelope({
      settlements: [{ title: "missing id" }],
      summary: { currency: "SAR" },
      readback: { source: "resolve_fieldops_settlements_v1" },
    });

    expect(mapped.settlements).toEqual([]);
    expect(mapped.summary.count).toBe(0);
    expect(mapped.readback.count).toBe(0);
  });
});

describe("resolveFieldopsSettlementsDisplayEnvelope", () => {
  const previewFallback: MobileV2SettlementLedgerEnvelope = {
    settlements: [
      {
        id: "preview-settlement-001",
        title: "Preview settlement",
        kind: "cod",
        scopeType: "driver_shift",
        status: "locked",
        expectedAmount: 100,
        collectedAmount: 95,
        remittedAmount: 95,
        varianceAmount: -5,
        currency: "SAR",
        windowLabel: "Preview",
        updatedAt: "2026-05-29T08:00:00.000Z",
      },
    ],
    summary: {
      count: 1,
      expectedAmount: 100,
      collectedAmount: 95,
      remittedAmount: 95,
      varianceAmount: -5,
      currency: "SAR",
    },
    readback: {
      source: "preview",
      count: 1,
      resolvedAt: "2026-05-29T08:00:00.000Z",
    },
  };

  it("does not expose preview settlement data before a live resolver response", () => {
    expect(resolveFieldopsSettlementsDisplayEnvelope(undefined, previewFallback, false)).toEqual(
      EMPTY_FIELDOPS_SETTLEMENTS_ENVELOPE,
    );
  });

  it("keeps preview data available only for showcase mode", () => {
    expect(resolveFieldopsSettlementsDisplayEnvelope(undefined, previewFallback, true)).toBe(
      previewFallback,
    );
  });

  it("prefers backend resolver data over any fallback", () => {
    const liveData = mapFieldopsSettlementsEnvelope({
      settlements: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          title: "Live settlement",
          expected_amount: 500,
        },
      ],
      summary: { count: 1, expected_amount: 500 },
      readback: { source: "resolve_fieldops_settlements_v1", count: 1 },
    });

    expect(resolveFieldopsSettlementsDisplayEnvelope(liveData, previewFallback, false)).toBe(
      liveData,
    );
  });
});
