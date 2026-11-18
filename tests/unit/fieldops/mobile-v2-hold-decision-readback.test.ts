import {
  readMobileV2HoldDecisionReadback,
  shortMobileV2HoldDecisionId,
} from "../../../apps/fieldops/src/mobile-v2-hold-decision-readback";
import type { MobileV2HoldItem } from "../../../apps/fieldops/src/mobile-v2-hold-queue-screen";

const HOLD_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_HOLD_ID = "99999999-2222-4333-8444-555555555555";
const DECISION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RESOLVED_AT = "2026-05-29T20:30:00Z";

const OTHER_HOLD: MobileV2HoldItem = Object.freeze({
  id: OTHER_HOLD_ID,
  parcel: "PCL-OTHER",
  reason: "damage",
  note: "Other hold still waiting",
  atMs: 1_779_999_999_000,
});

describe("Mobile V2 hold-decision readback", () => {
  test("accepts success only after backend resolver removes the decided hold", () => {
    expect(
      readMobileV2HoldDecisionReadback(
        {
          ok: true,
          decision_log_id: DECISION_ID,
          hold_id: HOLD_ID,
          hold_status: "resolved",
          resolved_at: RESOLVED_AT,
          state: "reinduct",
        },
        "reinduct",
        [OTHER_HOLD],
      ),
    ).toEqual({
      holdId: HOLD_ID,
      action: "reinduct",
      status: "resolved",
      decisionLogId: DECISION_ID,
      resolvedAt: RESOLVED_AT,
    });
  });

  test("does not expose visible success while the same hold is still in the queue", () => {
    expect(
      readMobileV2HoldDecisionReadback(
        {
          ok: true,
          decision_log_id: DECISION_ID,
          hold_id: HOLD_ID,
          hold_status: "resolved",
          state: "reinduct",
        },
        "reinduct",
        [
          OTHER_HOLD,
          {
            id: HOLD_ID,
            parcel: "PCL-HOLD",
            reason: "damage",
            note: "Still visible",
            atMs: 1_779_999_999_100,
          },
        ],
      ),
    ).toBeNull();
  });

  test("rejects mismatched backend status for the chosen action", () => {
    expect(
      readMobileV2HoldDecisionReadback(
        {
          ok: true,
          decision_log_id: DECISION_ID,
          hold_id: HOLD_ID,
          hold_status: "resolved",
          state: "discard",
        },
        "discard",
        [OTHER_HOLD],
      ),
    ).toBeNull();
  });

  test("maps all backend hold-decision terminal statuses", () => {
    expect(
      readMobileV2HoldDecisionReadback(
        {
          ok: true,
          decision_log_id: DECISION_ID,
          hold_id: HOLD_ID,
          hold_status: "escalated",
          state: "escalate",
        },
        "escalate",
        [],
      )?.status,
    ).toBe("escalated");

    expect(
      readMobileV2HoldDecisionReadback(
        {
          ok: true,
          decision_log_id: DECISION_ID,
          hold_id: HOLD_ID,
          hold_status: "discarded",
          state: "discard",
        },
        "discard",
        [],
      )?.status,
    ).toBe("discarded");
  });

  test("keeps short identifiers stable for native readback labels", () => {
    expect(shortMobileV2HoldDecisionId("  123456789abc  ")).toBe("12345678");
    expect(shortMobileV2HoldDecisionId("short")).toBe("short");
  });
});
