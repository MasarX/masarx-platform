import {
  customerChangeSchema,
  manualReviewSchema,
  marketplaceParticipantSchema,
  tenantSignupSchema,
} from "../../packages/config/schemas";

const uuid = "550e8400-e29b-41d4-a716-446655440000";

describe("lookup-backed review decision schemas", () => {
  test("do not hardcode approved/rejected as the only accepted lookup values", () => {
    expect(manualReviewSchema.safeParse({
      task_id: uuid,
      resolution_outcome: "custom_review_outcome",
    }).success).toBe(true);
    expect(tenantSignupSchema.safeParse({
      request_id: uuid,
      decision: "custom_tenant_decision",
      invite_redirect_to: "",
    }).success).toBe(true);
    expect(marketplaceParticipantSchema.safeParse({
      request_id: uuid,
      participant_type_key: "freelancer_driver",
      decision: "custom_marketplace_decision",
      invite_redirect_to: "",
    }).success).toBe(true);
    expect(customerChangeSchema.safeParse({
      support_case_id: uuid,
      decision: "custom_customer_change_decision",
    }).success).toBe(true);
  });

  test("still fail closed on missing lookup values", () => {
    expect(manualReviewSchema.safeParse({ task_id: uuid, resolution_outcome: "" }).success).toBe(false);
    expect(tenantSignupSchema.safeParse({ request_id: uuid, decision: "" }).success).toBe(false);
    expect(marketplaceParticipantSchema.safeParse({ request_id: uuid, decision: "" }).success).toBe(false);
    expect(customerChangeSchema.safeParse({ support_case_id: uuid, decision: "" }).success).toBe(false);
  });
});
