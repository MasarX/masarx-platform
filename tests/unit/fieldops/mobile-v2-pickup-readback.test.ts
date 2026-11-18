import {
  findMobileV2PickupReadback,
  parsePickupList,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import {
  getMobileV2PickupFailureReasonLabel,
  parseMobileV2PickupFailureReasons,
  selectMobileV2PickupFailureReason,
} from "../../../apps/fieldops/src/mobile-v2-pickup-policy";

const ROUTE_STOP_ID = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
const ROUTE_TASK_ID = "22222222-2222-4222-8222-222222222222";
const SHIPMENT_ID = "33333333-3333-4333-8333-333333333333";
const WORKFLOW_RUN_ID = "44444444-4444-4444-8444-444444444444";

describe("Mobile V2 pickup readback parsing", () => {
  test("maps resolver metadata into completed pickup handoff state", () => {
    const rows = parsePickupList([
      {
        task_id: `pickup:${ROUTE_STOP_ID}`,
        type: "pickup",
        title: "PU-260027",
        sub: "box 4",
        priority: 88,
        code: "PU-260027",
        meta: {
          route_stop_id: ROUTE_STOP_ID,
          route_stop_task_id: ROUTE_TASK_ID,
          shipment_id: SHIPMENT_ID,
          stop_kind: "pickup",
          expected_qty: 4,
          picked: 4,
          pickup_status: "completed",
          shipment_status: "in_transit",
          workflow_run_id: WORKFLOW_RUN_ID,
          shipment_action_id: "55555555-5555-4555-8555-555555555555",
        },
      },
    ], []);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: ROUTE_STOP_ID,
      routeStopId: ROUTE_STOP_ID,
      routeStopTaskId: ROUTE_TASK_ID,
      shipmentId: SHIPMENT_ID,
      workflowRunId: WORKFLOW_RUN_ID,
      expectedQty: 4,
      picked: 4,
      status: "completed",
      priority: "high",
    });
  });

  test("preserves pickup failure reason for native readback", () => {
    const rows = parsePickupList([
      {
        task_id: `pickup:${ROUTE_STOP_ID}`,
        title: "PU-260028",
        priority: 40,
        meta: {
          route_stop_id: ROUTE_STOP_ID,
          shipment_id: SHIPMENT_ID,
          expected_qty: 3,
          pickup_status: "failed",
          failure_reason: "pickup_not_ready",
          failure_note: "Merchant is still preparing the bags",
          picked: 0,
        },
      },
    ], []);

    expect(rows[0]).toMatchObject({
      status: "failed",
      expectedQty: 3,
      picked: 0,
      failureReason: "pickup_not_ready",
      failureNote: "Merchant is still preparing the bags",
      priority: "normal",
    });
  });

  test("matches same-context readback by route stop or shipment lineage", () => {
    const rows = parsePickupList([
      {
        task_id: "pickup:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        title: "Other",
        meta: { route_stop_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      },
      {
        task_id: `pickup:${ROUTE_STOP_ID}`,
        title: "Target",
        meta: {
          route_stop_id: ROUTE_STOP_ID,
          shipment_id: SHIPMENT_ID,
          workflow_run_id: WORKFLOW_RUN_ID,
          pickup_status: "failed",
          failure_reason: "pickup_not_ready",
        },
      },
    ], []);

    expect(findMobileV2PickupReadback(rows, {
      id: "pickup-fixture",
      routeStopId: null,
      routeStopTaskId: null,
      shipmentId: null,
      workflowRunId: WORKFLOW_RUN_ID,
    })?.id).toBe(ROUTE_STOP_ID);
  });

  test("returns fallback only for malformed payloads", () => {
    const fallback = parsePickupList([
      {
        id: "fixture",
        wb: "fixture",
        merchant: "Fixture",
        address: "",
        area: "",
        window: "",
        expectedQty: 1,
        picked: 0,
        status: "pending",
        priority: "normal",
        sealRequired: false,
      },
    ], []);

    expect(parsePickupList("bad", fallback)).toBe(fallback);
    expect(parsePickupList([], fallback)).toEqual([]);
  });
});

describe("Mobile V2 pickup failure policy", () => {
  test("resolves pickup_policy failure reasons without losing pickup_not_ready", () => {
    const reasons = parseMobileV2PickupFailureReasons({
      failure: {
        reschedule_reasons: ["sender_unavailable", "pickup_not_ready"],
        escalation_reasons: ["pickup_not_ready", "quantity_mismatch"],
      },
    });

    expect(reasons.map((reason) => reason.key)).toEqual([
      "sender_unavailable",
      "pickup_not_ready",
      "quantity_mismatch",
    ]);
    expect(selectMobileV2PickupFailureReason(reasons)).toBe("pickup_not_ready");
    expect(getMobileV2PickupFailureReasonLabel("pickup_not_ready", reasons)).toBe("Pickup Not Ready");
  });
});
