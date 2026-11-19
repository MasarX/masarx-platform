import {
  MOBILE_V2_POD_DEFAULT_POLICY,
  filterPodFailReasons,
  parseMobileV2PodFailReason,
  parseMobileV2PodPolicy,
  podPolicyAllowsCod,
  podPolicyHasMethod,
  resolveMobileV2PodMethodsForStop,
  resolveMobileV2PodPolicyForStop,
  resolvePodSubmitGate,
  type MobileV2PodFailReason,
  type MobileV2PodPolicy,
} from "../../../apps/fieldops/src/mobile-v2-pod-policy";

const FULL_POLICY = {
  version: 1,
  methods: ["scan", "photo", "sig", "otp", "id", "cod"],
  fail_reasons: [
    {
      code: "recipient_unavailable",
      label: "Recipient unavailable",
      reattempt: true,
      photo: false,
      note: true,
      escalate: false,
    },
    {
      code: "parcel_damaged",
      label: "Parcel damaged",
      reattempt: false,
      photo: true,
      note: true,
      escalate: true,
    },
    {
      code: "cod_unpaid",
      label: "COD not paid",
      reattempt: true,
      note: true,
      cod_only: true, // snake_case from JSON Schema
    },
  ],
  cod_currency: "SAR",
};

describe("parseMobileV2PodFailReason", () => {
  test("parses a complete reason", () => {
    const r = parseMobileV2PodFailReason({
      code: "x",
      label: "X",
      reattempt: true,
      photo: true,
      note: true,
      escalate: true,
      codOnly: true,
    });
    expect(r).not.toBeNull();
    expect(r?.code).toBe("x");
    expect(r?.reattempt).toBe(true);
    expect(r?.codOnly).toBe(true);
  });

  test("snake_case cod_only is accepted (DB JSON form)", () => {
    const r = parseMobileV2PodFailReason({ code: "x", label: "X", cod_only: true });
    expect(r?.codOnly).toBe(true);
  });

  test("flags default to false when missing", () => {
    const r = parseMobileV2PodFailReason({ code: "x", label: "X" });
    expect(r?.reattempt).toBe(false);
    expect(r?.photo).toBe(false);
    expect(r?.note).toBe(false);
    expect(r?.escalate).toBe(false);
    expect(r?.codOnly).toBe(false);
  });

  test("missing required fields returns null", () => {
    expect(parseMobileV2PodFailReason({ label: "no code" })).toBeNull();
    expect(parseMobileV2PodFailReason({ code: "no label" })).toBeNull();
    expect(parseMobileV2PodFailReason({})).toBeNull();
  });

  test("non-object input returns null", () => {
    expect(parseMobileV2PodFailReason(null)).toBeNull();
    expect(parseMobileV2PodFailReason("string")).toBeNull();
    expect(parseMobileV2PodFailReason([])).toBeNull();
  });
});

describe("parseMobileV2PodPolicy", () => {
  test("parses the full policy with method dedup + reason taxonomy", () => {
    const p = parseMobileV2PodPolicy(FULL_POLICY);
    expect(p.version).toBe(1);
    expect(p.methods).toEqual(["scan", "photo", "sig", "otp", "id", "cod"]);
    expect(p.failReasons).toHaveLength(3);
    expect(p.codCurrency).toBe("SAR");
  });

  test("malformed root returns the default policy", () => {
    expect(parseMobileV2PodPolicy(null)).toEqual(MOBILE_V2_POD_DEFAULT_POLICY);
    expect(parseMobileV2PodPolicy("oops")).toEqual(MOBILE_V2_POD_DEFAULT_POLICY);
    expect(parseMobileV2PodPolicy([])).toEqual(MOBILE_V2_POD_DEFAULT_POLICY);
  });

  test("unknown methods are filtered out; remaining methods preserved", () => {
    const p = parseMobileV2PodPolicy({ methods: ["scan", "imaginary", "photo"] });
    expect(p.methods).toEqual(["scan", "photo"]);
  });

  test("empty/all-invalid methods array falls back to default methods", () => {
    expect(parseMobileV2PodPolicy({ methods: [] }).methods).toEqual(MOBILE_V2_POD_DEFAULT_POLICY.methods);
    expect(parseMobileV2PodPolicy({ methods: ["nope"] }).methods).toEqual(
      MOBILE_V2_POD_DEFAULT_POLICY.methods,
    );
  });

  test("methods are de-duplicated while preserving order", () => {
    const p = parseMobileV2PodPolicy({ methods: ["scan", "photo", "scan"] });
    expect(p.methods).toEqual(["scan", "photo"]);
  });

  test("malformed fail_reasons rows are dropped; valid ones kept", () => {
    const p = parseMobileV2PodPolicy({
      fail_reasons: [
        { code: "ok1", label: "Ok 1" },
        { code: "no-label" },
        null,
        { code: "ok2", label: "Ok 2" },
      ],
    });
    expect(p.failReasons.map((r) => r.code)).toEqual(["ok1", "ok2"]);
  });

  test("duplicate reason codes are de-duplicated (first wins)", () => {
    const p = parseMobileV2PodPolicy({
      fail_reasons: [
        { code: "x", label: "first" },
        { code: "x", label: "second" },
      ],
    });
    expect(p.failReasons).toHaveLength(1);
    expect(p.failReasons[0]?.label).toBe("first");
  });

  test("empty / missing fail_reasons array falls back to default reasons", () => {
    expect(parseMobileV2PodPolicy({}).failReasons).toEqual(MOBILE_V2_POD_DEFAULT_POLICY.failReasons);
    expect(parseMobileV2PodPolicy({ fail_reasons: [] }).failReasons).toEqual(
      MOBILE_V2_POD_DEFAULT_POLICY.failReasons,
    );
  });

  test("default policy exposes access_restricted as note-gated attempt evidence", () => {
    const reason = MOBILE_V2_POD_DEFAULT_POLICY.failReasons.find((row) => row.code === "access_restricted");
    expect(reason).toMatchObject({
      label: "Access restricted",
      reattempt: true,
      photo: false,
      note: true,
      escalate: false,
      codOnly: false,
    });
  });

  test("camelCase failReasons + codCurrency keys also accepted", () => {
    const p = parseMobileV2PodPolicy({
      failReasons: [{ code: "x", label: "X" }],
      codCurrency: "USD",
    });
    expect(p.failReasons).toHaveLength(1);
    expect(p.codCurrency).toBe("USD");
  });

  test("invalid version falls back to default", () => {
    expect(parseMobileV2PodPolicy({ version: -1 }).version).toBe(MOBILE_V2_POD_DEFAULT_POLICY.version);
    expect(parseMobileV2PodPolicy({ version: "two" }).version).toBe(MOBILE_V2_POD_DEFAULT_POLICY.version);
  });
});

describe("podPolicyHasMethod", () => {
  test("hits and misses", () => {
    const p = parseMobileV2PodPolicy(FULL_POLICY);
    expect(podPolicyHasMethod(p, "scan")).toBe(true);
    expect(podPolicyHasMethod(p, "cod")).toBe(true);
  });
});

describe("podPolicyAllowsCod", () => {
  const policyWithCod = parseMobileV2PodPolicy(FULL_POLICY);
  const policyNoCod = parseMobileV2PodPolicy({
    methods: ["scan", "photo", "sig"],
  });

  test("policy + shipment with COD -> allowed", () => {
    expect(podPolicyAllowsCod(policyWithCod, { hasCod: true })).toBe(true);
  });

  test("policy + shipment without COD -> denied", () => {
    expect(podPolicyAllowsCod(policyWithCod, { hasCod: false })).toBe(false);
  });

  test("policy without COD method -> always denied", () => {
    expect(podPolicyAllowsCod(policyNoCod, { hasCod: true })).toBe(false);
    expect(podPolicyAllowsCod(policyNoCod, { hasCod: false })).toBe(false);
  });
});

describe("resolveMobileV2PodMethodsForStop", () => {
  test("includes COD when the backend stop detail checklist requires it", () => {
    const policy = parseMobileV2PodPolicy({ methods: ["scan", "photo", "sig"] });

    expect(
      resolveMobileV2PodMethodsForStop(policy, [
        { key: "scan" },
        { key: "photo" },
        { key: "sig" },
        { key: "cod" },
      ]),
    ).toEqual(["scan", "photo", "sig", "cod"]);
  });

  test("dedupes methods and ignores unknown checklist keys", () => {
    const policy = parseMobileV2PodPolicy({ methods: ["scan", "photo", "scan", "imaginary"] });

    expect(
      resolveMobileV2PodMethodsForStop(policy, [
        { key: "scan" },
        { key: "cod" },
        { key: "unknown" },
      ]),
    ).toEqual(["scan", "photo", "cod"]);
  });
});

describe("resolveMobileV2PodPolicyForStop", () => {
  test("keeps policy metadata while exposing the stop-specific POD methods to the wizard", () => {
    const policy = parseMobileV2PodPolicy({
      version: 3,
      methods: ["scan", "photo", "sig"],
      fail_reasons: [{ code: "recipient_unavailable", label: "Recipient unavailable", note: true }],
      cod_currency: "SAR",
    });

    const resolved = resolveMobileV2PodPolicyForStop(policy, [
      { key: "scan" },
      { key: "photo" },
      { key: "sig" },
      { key: "cod" },
    ]);

    expect(resolved).toMatchObject({
      version: 3,
      codCurrency: "SAR",
    });
    expect(resolved.failReasons).toBe(policy.failReasons);
    expect(resolved.methods).toEqual(["scan", "photo", "sig", "cod"]);
  });
});

describe("resolvePodSubmitGate", () => {
  function reason(over: Partial<MobileV2PodFailReason> = {}): MobileV2PodFailReason {
    return Object.freeze({
      code: "x",
      label: "X",
      reattempt: false,
      photo: false,
      note: false,
      escalate: false,
      codOnly: false,
      ...over,
    });
  }

  test("no flags -> always submittable", () => {
    const r = reason();
    const gate = resolvePodSubmitGate(r, {
      hasPhoto: false,
      hasNote: false,
      escalateAcknowledged: false,
    });
    expect(gate.canSubmit).toBe(true);
    expect(gate.missing).toEqual([]);
  });

  test("photo flag missing -> blocked", () => {
    const gate = resolvePodSubmitGate(reason({ photo: true }), {
      hasPhoto: false,
      hasNote: false,
      escalateAcknowledged: false,
    });
    expect(gate.canSubmit).toBe(false);
    expect(gate.missing).toContain("photo");
  });

  test("photo + note + escalate ALL missing produces all 3 in missing", () => {
    const gate = resolvePodSubmitGate(
      reason({ photo: true, note: true, escalate: true }),
      { hasPhoto: false, hasNote: false, escalateAcknowledged: false },
    );
    expect(gate.canSubmit).toBe(false);
    expect(gate.missing).toEqual(["photo", "note", "escalate_ack"]);
  });

  test("escalate ack-only reason: ack provided -> submittable", () => {
    const gate = resolvePodSubmitGate(reason({ escalate: true }), {
      hasPhoto: false,
      hasNote: false,
      escalateAcknowledged: true,
    });
    expect(gate.canSubmit).toBe(true);
  });

  test("photo provided satisfies photo flag", () => {
    const gate = resolvePodSubmitGate(reason({ photo: true }), {
      hasPhoto: true,
      hasNote: false,
      escalateAcknowledged: false,
    });
    expect(gate.canSubmit).toBe(true);
  });
});

describe("filterPodFailReasons", () => {
  const policy = parseMobileV2PodPolicy(FULL_POLICY);

  test("non-COD shipment hides cod_only reasons", () => {
    const out = filterPodFailReasons(policy, { hasCod: false });
    expect(out.find((r) => r.code === "cod_unpaid")).toBeUndefined();
    expect(out.find((r) => r.code === "recipient_unavailable")).toBeDefined();
  });

  test("COD shipment keeps every reason", () => {
    const out = filterPodFailReasons(policy, { hasCod: true });
    expect(out.find((r) => r.code === "cod_unpaid")).toBeDefined();
  });
});
