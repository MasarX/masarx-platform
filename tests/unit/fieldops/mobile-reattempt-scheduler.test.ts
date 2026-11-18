import {
  DEFAULT_REATTEMPT_MAX_ATTEMPTS,
  DEFAULT_REATTEMPT_SLOTS,
  buildNdrNotificationDraft,
  buildReattemptSuggestions,
  type ReattemptPolicyLike,
} from "../../../apps/fieldops/src/mobile-reattempt-scheduler";

const T0 = Date.parse("2026-04-21T08:00:00.000Z");
const MIN = 60_000;

describe("buildReattemptSuggestions — default path", () => {
  test("uses built-in defaults when policy is null", () => {
    const suggestions = buildReattemptSuggestions({
      reasonKey: "customer_unavailable",
      policy: null,
      previousAttemptCount: 0,
      now: T0,
    });
    expect(suggestions).toHaveLength(DEFAULT_REATTEMPT_SLOTS.length);
    expect(suggestions[0]?.label).toBe("In 1 hour");
    expect(suggestions[0]?.scheduledAt).toBe(new Date(T0 + 60 * MIN).toISOString());
    expect(suggestions[1]?.label).toBe("Tomorrow morning");
    expect(suggestions[1]?.scheduledAt).toBe(new Date(T0 + 1440 * MIN).toISOString());
    expect(suggestions[0]?.channel).toBe("default");
    expect(suggestions[0]?.notifyCustomer).toBe(true);
    expect(suggestions[0]?.requiresNotes).toBe(false);
  });

  test("uses policy.suggested_slots when provided", () => {
    const policy: ReattemptPolicyLike = {
      suggested_slots: [
        { label: "In 30 min", offset_minutes: 30 },
        { label: "Later today", offset_minutes: 240 },
      ],
    };
    const suggestions = buildReattemptSuggestions({
      reasonKey: "wrong_address",
      policy,
      previousAttemptCount: 0,
      now: T0,
    });
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]?.label).toBe("In 30 min");
    expect(suggestions[0]?.scheduledAt).toBe(new Date(T0 + 30 * MIN).toISOString());
    expect(suggestions[0]?.channel).toBe("default");
  });

  test("notify_customer=false is honored when no reason override exists", () => {
    const policy: ReattemptPolicyLike = {
      suggested_slots: [{ label: "In 1 hour", offset_minutes: 60 }],
      notify_customer: false,
    };
    const suggestions = buildReattemptSuggestions({
      reasonKey: "other",
      policy,
      previousAttemptCount: 0,
      now: T0,
    });
    expect(suggestions[0]?.notifyCustomer).toBe(false);
  });
});

describe("buildReattemptSuggestions — reason_specific override", () => {
  const policy: ReattemptPolicyLike = {
    suggested_slots: [
      { label: "In 1 hour", offset_minutes: 60 },
      { label: "Tomorrow morning", offset_minutes: 1440 },
    ],
    reason_specific: {
      wrong_address: {
        slots: [{ label: "After address update", offset_minutes: 15 }],
        notify: false,
      },
      damaged: {
        slots: [
          { label: "Next morning", offset_minutes: 720 },
          { label: "Next afternoon", offset_minutes: 900 },
        ],
      },
    },
  };

  test("selects reason_specific slots and marks channel reason_specific", () => {
    const suggestions = buildReattemptSuggestions({
      reasonKey: "wrong_address",
      policy,
      previousAttemptCount: 0,
      now: T0,
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.label).toBe("After address update");
    expect(suggestions[0]?.channel).toBe("reason_specific");
    expect(suggestions[0]?.scheduledAt).toBe(new Date(T0 + 15 * MIN).toISOString());
  });

  test("reason_specific notify override wins over policy.notify_customer", () => {
    const policyWithNotifyTrue: ReattemptPolicyLike = {
      ...policy,
      notify_customer: true,
    };
    const suggestions = buildReattemptSuggestions({
      reasonKey: "wrong_address",
      policy: policyWithNotifyTrue,
      previousAttemptCount: 0,
      now: T0,
    });
    expect(suggestions[0]?.notifyCustomer).toBe(false);
  });

  test("reason_specific without notify override falls back to policy default", () => {
    const suggestions = buildReattemptSuggestions({
      reasonKey: "damaged",
      policy,
      previousAttemptCount: 0,
      now: T0,
    });
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]?.channel).toBe("reason_specific");
    expect(suggestions[0]?.notifyCustomer).toBe(true);
  });

  test("unknown reason falls back to default slots", () => {
    const suggestions = buildReattemptSuggestions({
      reasonKey: "missing_key",
      policy,
      previousAttemptCount: 0,
      now: T0,
    });
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]?.channel).toBe("default");
    expect(suggestions[0]?.label).toBe("In 1 hour");
  });
});

describe("buildReattemptSuggestions — max_attempts cap", () => {
  test("caps suggestions at max_attempts", () => {
    const policy: ReattemptPolicyLike = {
      suggested_slots: [
        { label: "A", offset_minutes: 30 },
        { label: "B", offset_minutes: 60 },
        { label: "C", offset_minutes: 90 },
        { label: "D", offset_minutes: 120 },
      ],
      max_attempts: 2,
    };
    const suggestions = buildReattemptSuggestions({
      reasonKey: "x",
      policy,
      previousAttemptCount: 0,
      now: T0,
    });
    expect(suggestions.map((s) => s.label)).toEqual(["A", "B"]);
  });

  test("uses default max_attempts when unspecified", () => {
    const policy: ReattemptPolicyLike = {
      suggested_slots: [
        { label: "A", offset_minutes: 30 },
        { label: "B", offset_minutes: 60 },
        { label: "C", offset_minutes: 90 },
        { label: "D", offset_minutes: 120 },
        { label: "E", offset_minutes: 150 },
      ],
    };
    const suggestions = buildReattemptSuggestions({
      reasonKey: "x",
      policy,
      previousAttemptCount: 0,
      now: T0,
    });
    expect(suggestions).toHaveLength(DEFAULT_REATTEMPT_MAX_ATTEMPTS);
  });
});

describe("buildReattemptSuggestions — requiresNotes boundary", () => {
  const policy: ReattemptPolicyLike = {
    suggested_slots: [{ label: "In 1 hour", offset_minutes: 60 }],
    require_notes_on_attempts_above: 1,
  };

  test("first attempt (previousAttemptCount=0, attempt 1) does not require notes", () => {
    const suggestions = buildReattemptSuggestions({
      reasonKey: "x",
      policy,
      previousAttemptCount: 0,
      now: T0,
    });
    expect(suggestions[0]?.requiresNotes).toBe(false);
  });

  test("second attempt (previousAttemptCount=1, attempt 2) requires notes", () => {
    const suggestions = buildReattemptSuggestions({
      reasonKey: "x",
      policy,
      previousAttemptCount: 1,
      now: T0,
    });
    expect(suggestions[0]?.requiresNotes).toBe(true);
  });

  test("threshold=2 requires notes only above 2 prior attempts", () => {
    const highThresholdPolicy: ReattemptPolicyLike = {
      suggested_slots: [{ label: "In 1 hour", offset_minutes: 60 }],
      require_notes_on_attempts_above: 2,
    };
    const attempt2 = buildReattemptSuggestions({
      reasonKey: "x",
      policy: highThresholdPolicy,
      previousAttemptCount: 1,
      now: T0,
    });
    expect(attempt2[0]?.requiresNotes).toBe(false);
    const attempt3 = buildReattemptSuggestions({
      reasonKey: "x",
      policy: highThresholdPolicy,
      previousAttemptCount: 2,
      now: T0,
    });
    expect(attempt3[0]?.requiresNotes).toBe(true);
  });
});

describe("buildNdrNotificationDraft", () => {
  const baseInput = {
    reasonKey: "customer_unavailable",
    nextAttemptIso: new Date(T0 + 60 * MIN).toISOString(),
    communicationPolicyChannels: ["sms", "whatsapp"] as Array<
      "sms" | "whatsapp" | "email" | "call"
    >,
    notifyCustomer: true,
    stopId: "stop_1",
    customerPhone: "+000000000000",
    customerName: "Jane Doe",
  };

  test("returns draft with filtered channels and metadata", () => {
    const draft = buildNdrNotificationDraft(baseInput);
    expect(draft).not.toBeNull();
    expect(draft?.channels).toEqual(["sms", "whatsapp"]);
    expect(draft?.messageKey).toBe("ndr.customer_unavailable");
    expect(draft?.etaIso).toBe(new Date(T0 + 60 * MIN).toISOString());
    expect(draft?.metadata).toEqual({
      stopId: "stop_1",
      reasonKey: "customer_unavailable",
      customerName: "Jane Doe",
      customerPhone: "+000000000000",
    });
  });

  test("filters out 'call' channel from communication channels", () => {
    const draft = buildNdrNotificationDraft({
      ...baseInput,
      communicationPolicyChannels: ["call", "sms", "email"],
    });
    expect(draft?.channels).toEqual(["sms", "email"]);
  });

  test("returns null when notifyCustomer is false", () => {
    const draft = buildNdrNotificationDraft({ ...baseInput, notifyCustomer: false });
    expect(draft).toBeNull();
  });

  test("returns null when customerPhone is missing", () => {
    const draft = buildNdrNotificationDraft({ ...baseInput, customerPhone: null });
    expect(draft).toBeNull();
  });

  test("returns null when customerPhone is blank", () => {
    const draft = buildNdrNotificationDraft({ ...baseInput, customerPhone: "   " });
    expect(draft).toBeNull();
  });

  test("returns null when communicationPolicyChannels has no supported channels", () => {
    const draft = buildNdrNotificationDraft({
      ...baseInput,
      communicationPolicyChannels: ["call"],
    });
    expect(draft).toBeNull();
  });

  test("etaIso falls through when nextAttemptIso is null", () => {
    const draft = buildNdrNotificationDraft({ ...baseInput, nextAttemptIso: null });
    expect(draft?.etaIso).toBeNull();
  });

  test("customerName null is preserved in metadata", () => {
    const draft = buildNdrNotificationDraft({ ...baseInput, customerName: null });
    expect(draft?.metadata.customerName).toBeNull();
  });

  test("dedupes repeated channels in communication policy", () => {
    const draft = buildNdrNotificationDraft({
      ...baseInput,
      communicationPolicyChannels: ["sms", "sms", "whatsapp", "whatsapp"],
    });
    expect(draft?.channels).toEqual(["sms", "whatsapp"]);
  });
});
