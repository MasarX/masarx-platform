import {
  uuidSchema,
  emailSchema,
  phoneSchema,
  createPhoneSchema,
  DEFAULT_PHONE_PATTERN,
  trackingNumberSchema,
  statusSchema,
  createStatusSchema,
  lookupValueSchema,
  createLookupValueSchema,
  requiredString,
  optionalString,
} from "../../packages/config/schemas/fields";

describe("uuidSchema", () => {
  test("accepts valid UUID v4", () => {
    expect(uuidSchema.safeParse("550e8400-e29b-41d4-a716-446655440000").success).toBe(true);
  });
  test("rejects invalid UUID", () => {
    expect(uuidSchema.safeParse("not-a-uuid").success).toBe(false);
  });
  test("rejects empty string", () => {
    expect(uuidSchema.safeParse("").success).toBe(false);
  });
});

describe("emailSchema", () => {
  test("accepts valid email", () => {
    expect(emailSchema.safeParse("user@example.com").success).toBe(true);
  });
  test("rejects invalid email", () => {
    expect(emailSchema.safeParse("not-an-email").success).toBe(false);
  });
  test("rejects empty string", () => {
    expect(emailSchema.safeParse("").success).toBe(false);
  });
});

describe("phoneSchema", () => {
  const internationalFixture = "+12025550123";

  test("keeps the Saudi mobile prefixes in the default pattern", () => {
    expect(DEFAULT_PHONE_PATTERN.source).toBe(String.raw`^(?:\+966|0)5\d{8}$`);
  });
  test("accepts a valid international number with a tenant phone pattern", () => {
    expect(createPhoneSchema(/^\+1[0-9]{10}$/).safeParse(internationalFixture).success).toBe(true);
  });
  test("rejects the non-Saudi fixture under the default pattern", () => {
    expect(phoneSchema.safeParse(internationalFixture).success).toBe(false);
  });
  test("rejects a short Saudi mobile input", () => {
    expect(phoneSchema.safeParse("051234").success).toBe(false);
  });
});

describe("trackingNumberSchema", () => {
  test("accepts valid 2-letter tracking number", () => {
    expect(trackingNumberSchema.safeParse("SA-1234-56789").success).toBe(true);
  });
  test("accepts valid 3-letter tracking number", () => {
    expect(trackingNumberSchema.safeParse("MXR-1234-56789").success).toBe(true);
  });
  test("rejects lowercase prefix", () => {
    expect(trackingNumberSchema.safeParse("sa-1234-56789").success).toBe(false);
  });
  test("rejects wrong digit count", () => {
    expect(trackingNumberSchema.safeParse("SA-123-56789").success).toBe(false);
  });
  test("rejects missing separator", () => {
    expect(trackingNumberSchema.safeParse("SA123456789").success).toBe(false);
  });
});

describe("statusSchema (permissive)", () => {
  test.each([
    "draft",
    "pending",
    "active",
    "in_progress",
    "completed",
    "cancelled",
    "failed",
    "archived",
    "custom_tenant_status",
  ])("accepts %s", (status) => {
    expect(statusSchema.safeParse(status).success).toBe(true);
  });

  test("accepts any non-empty string (DB-driven statuses)", () => {
    expect(statusSchema.safeParse("unknown").success).toBe(true);
  });

  test("rejects empty string", () => {
    expect(statusSchema.safeParse("").success).toBe(false);
  });
});

describe("createStatusSchema (strict from DB values)", () => {
  const strictSchema = createStatusSchema(["draft", "pending", "active"]);

  test("accepts allowed status", () => {
    expect(strictSchema.safeParse("draft").success).toBe(true);
    expect(strictSchema.safeParse("pending").success).toBe(true);
    expect(strictSchema.safeParse("active").success).toBe(true);
  });

  test("rejects status not in allowed list", () => {
    expect(strictSchema.safeParse("unknown").success).toBe(false);
    expect(strictSchema.safeParse("cancelled").success).toBe(false);
  });

  test("rejects empty string", () => {
    expect(strictSchema.safeParse("").success).toBe(false);
  });
});

describe("lookupValueSchema (DB-driven)", () => {
  test("accepts any non-empty canonical lookup key", () => {
    expect(lookupValueSchema.safeParse("approved").success).toBe(true);
    expect(lookupValueSchema.safeParse("custom_tenant_decision").success).toBe(true);
  });

  test("rejects empty lookup keys", () => {
    expect(lookupValueSchema.safeParse("").success).toBe(false);
  });
});

describe("createLookupValueSchema (strict from DB values)", () => {
  const strictSchema = createLookupValueSchema(["approved", "rejected"]);

  test("accepts DB-provided lookup values", () => {
    expect(strictSchema.safeParse("approved").success).toBe(true);
    expect(strictSchema.safeParse("rejected").success).toBe(true);
  });

  test("rejects values outside the supplied lookup rows", () => {
    expect(strictSchema.safeParse("withdrawn").success).toBe(false);
  });
});

describe("requiredString", () => {
  test("accepts non-empty string", () => {
    expect(requiredString.safeParse("hello").success).toBe(true);
  });
  test("rejects empty string", () => {
    const result = requiredString.safeParse("");
    expect(result.success).toBe(false);
  });
  test("rejects undefined", () => {
    expect(requiredString.safeParse(undefined).success).toBe(false);
  });
});

describe("optionalString", () => {
  test("accepts string", () => {
    expect(optionalString.safeParse("hello").success).toBe(true);
  });
  test("accepts undefined", () => {
    expect(optionalString.safeParse(undefined).success).toBe(true);
  });
  test("accepts empty string", () => {
    expect(optionalString.safeParse("").success).toBe(true);
  });
});
