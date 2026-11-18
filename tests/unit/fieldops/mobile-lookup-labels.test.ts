import {
  FIELDOPS_LOOKUP_MISSING_FRIENDLY_LABEL,
  formatFieldOpsLookupKeyLabel,
  resolveFieldOpsLookupOptionLabel,
} from "../../../apps/fieldops/src/mobile-lookup-labels";

describe("fieldops mobile lookup labels", () => {
  test("uses friendly labels while preserving canonical lookup values", () => {
    expect(
      resolveFieldOpsLookupOptionLabel(
        { value: "national_id", label: "National ID" },
        "national_id",
      ),
    ).toBe("National ID");
  });

  test("falls back to metadata display labels before machine-key labels", () => {
    expect(
      resolveFieldOpsLookupOptionLabel(
        {
          value: "national_id",
          label: "",
          metadata: { display_label: "Government ID" },
        },
        "national_id",
      ),
    ).toBe("Government ID");
  });

  test("does not render raw UUID labels as primary visible text", () => {
    expect(
      resolveFieldOpsLookupOptionLabel(
        {
          value: "national_id",
          label: "550e8400-e29b-41d4-a716-446655440000",
        },
        "national_id",
      ),
    ).toBe("National ID");
  });

  test("fails closed when the canonical value itself is UUID-like", () => {
    expect(
      resolveFieldOpsLookupOptionLabel(
        {
          value: "550e8400-e29b-41d4-a716-446655440000",
          label: "550e8400-e29b-41d4-a716-446655440000",
        },
        "550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe(FIELDOPS_LOOKUP_MISSING_FRIENDLY_LABEL);
  });

  test("formats machine lookup keys into readable labels", () => {
    expect(formatFieldOpsLookupKeyLabel("hold_at_branch")).toBe("Hold At Branch");
  });

  test("renders attempt outcome labels while keeping canonical values submission-only", () => {
    const canonicalAttemptOutcome = "partial_delivery";

    expect(
      resolveFieldOpsLookupOptionLabel(
        {
          value: canonicalAttemptOutcome,
          label: "",
        },
        canonicalAttemptOutcome,
      ),
    ).toBe("Partial Delivery");
    expect(canonicalAttemptOutcome).toBe("partial_delivery");
  });
});
