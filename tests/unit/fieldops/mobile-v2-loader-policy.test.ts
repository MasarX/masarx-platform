import {
  MOBILE_V2_LOADER_DEFAULT_POLICY,
  getLoaderActionSubmitRpc,
  getEnabledLoaderActions,
  isLoaderActionEnabled,
  parseMobileV2LoaderAction,
  parseMobileV2LoaderPolicy,
  resolveEffectiveLoaderAction,
  shouldConfirmLoaderBulkSubmit,
} from "../../../apps/fieldops/src/mobile-v2-loader-policy";

const FULL_POLICY = {
  version: 1,
  scan_modes: ["single", "bulk"],
  default_mode: "single",
  actions: [
    { key: "load", label: "Load", icon: "truck", submit_rpc: "record_scan_event_v1" },
    { key: "unload", label: "Unload", icon: "package" },
    { key: "receive", label: "Receive", icon: "box" },
    { key: "sort", label: "Sort", icon: "split", submit_rpc: "induct_fieldops_parcel_v1" },
    { key: "verify", label: "Verify", icon: "check-double" },
    { key: "damage", label: "Damage", icon: "alert" },
    { key: "shelve", label: "Shelve", icon: "layers" },
    { key: "inter_hub_transfer", label: "Transfer", icon: "route" },
  ],
  enabled_actions: ["load", "unload", "receive", "sort"],
  default_action: "sort",
  context_chips: ["route", "bay"],
  confirm_threshold: 25,
  sound_enabled: true,
  haptic_on_scan: true,
  session_context: {
    bay: "FT-LIVE-BAY-01",
    wave_label: "FT-LIVE-WAVE",
    route_label: "FT-LIVE-ROUTE",
    cut_off: "23:30",
  },
};

describe("parseMobileV2LoaderAction", () => {
  test("parses a complete action", () => {
    const a = parseMobileV2LoaderAction({ key: "load", label: "Load", icon: "truck" });
    expect(a).toEqual({ key: "load", label: "Load", icon: "truck" });
  });

  test("parses row-declared submit RPC for production-wired actions", () => {
    const a = parseMobileV2LoaderAction({
      key: "sort",
      label: "Sort",
      icon: "split",
      submit_rpc: "induct_fieldops_parcel_v1",
    });
    expect(a).toEqual({
      key: "sort",
      label: "Sort",
      icon: "split",
      submitRpc: "induct_fieldops_parcel_v1",
    });
  });

  test("unknown icon falls back to package (safe placeholder)", () => {
    const a = parseMobileV2LoaderAction({ key: "x", label: "X", icon: "unicorn" });
    expect(a?.icon).toBe("package");
  });

  test("missing required fields returns null", () => {
    expect(parseMobileV2LoaderAction({ key: "x" })).toBeNull();
    expect(parseMobileV2LoaderAction({ label: "y" })).toBeNull();
    expect(parseMobileV2LoaderAction({})).toBeNull();
  });

  test("non-object input returns null", () => {
    expect(parseMobileV2LoaderAction(null)).toBeNull();
    expect(parseMobileV2LoaderAction("string")).toBeNull();
    expect(parseMobileV2LoaderAction([])).toBeNull();
  });
});

describe("parseMobileV2LoaderPolicy", () => {
  test("parses the full policy", () => {
    const p = parseMobileV2LoaderPolicy(FULL_POLICY);
    expect(p.version).toBe(1);
    expect(p.scanModes).toEqual(["single", "bulk"]);
    expect(p.defaultMode).toBe("single");
    expect(p.actions).toHaveLength(8);
    expect(p.enabledActions).toEqual(["load", "unload", "receive", "sort"]);
    expect(p.defaultAction).toBe("sort");
    expect(getLoaderActionSubmitRpc(p, "sort")).toBe("induct_fieldops_parcel_v1");
    expect(getLoaderActionSubmitRpc(p, "load")).toBe("record_scan_event_v1");
    expect(p.confirmThreshold).toBe(25);
    expect(p.soundEnabled).toBe(true);
    expect(p.hapticOnScan).toBe(true);
    expect(p.sessionContext).toEqual({
      bay: "FT-LIVE-BAY-01",
      waveLabel: "FT-LIVE-WAVE",
      routeLabel: "FT-LIVE-ROUTE",
      cutOff: "23:30",
    });
  });

  test("malformed root returns the default policy", () => {
    expect(parseMobileV2LoaderPolicy(null)).toEqual(MOBILE_V2_LOADER_DEFAULT_POLICY);
    expect(parseMobileV2LoaderPolicy("oops")).toEqual(MOBILE_V2_LOADER_DEFAULT_POLICY);
    expect(parseMobileV2LoaderPolicy([])).toEqual(MOBILE_V2_LOADER_DEFAULT_POLICY);
  });

  test("unknown scan modes are filtered out", () => {
    const p = parseMobileV2LoaderPolicy({ scan_modes: ["single", "imaginary"] });
    expect(p.scanModes).toEqual(["single"]);
  });

  test("camelCase keys also accepted", () => {
    const p = parseMobileV2LoaderPolicy({
      scanModes: ["bulk"],
      defaultMode: "bulk",
      defaultAction: "unload",
      enabledActions: ["unload"],
      contextChips: ["bay"],
      confirmThreshold: 10,
      soundEnabled: false,
      hapticOnScan: false,
    });
    expect(p.scanModes).toEqual(["bulk"]);
    expect(p.defaultMode).toBe("bulk");
    expect(p.defaultAction).toBe("unload");
    expect(p.confirmThreshold).toBe(10);
    expect(p.soundEnabled).toBe(false);
    expect(p.hapticOnScan).toBe(false);
  });

  test("session_context requires a row-provided bay", () => {
    expect(parseMobileV2LoaderPolicy({ session_context: { bay: "B-01" } }).sessionContext).toEqual({
      bay: "B-01",
      waveLabel: null,
      routeLabel: null,
      cutOff: null,
    });
    expect(parseMobileV2LoaderPolicy({ session_context: { wave_label: "wave" } }).sessionContext).toBeNull();
  });

  test("enabled_actions referencing unknown keys are dropped", () => {
    const p = parseMobileV2LoaderPolicy({
      ...FULL_POLICY,
      enabled_actions: ["load", "imaginary_action", "verify"],
    });
    expect(p.enabledActions).toEqual(["load", "verify"]);
  });

  test("default_action falls back to first enabled when invalid", () => {
    const p = parseMobileV2LoaderPolicy({
      ...FULL_POLICY,
      enabled_actions: ["sort", "verify"],
      default_action: "load", // not in enabled set
    });
    expect(p.defaultAction).toBe("sort");
  });

  test("dedupes duplicate action keys (first wins)", () => {
    const p = parseMobileV2LoaderPolicy({
      actions: [
        { key: "x", label: "first", icon: "package" },
        { key: "x", label: "second", icon: "truck" },
      ],
      enabled_actions: ["x"],
    });
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]?.label).toBe("first");
  });

  test("malformed action rows are dropped; valid ones kept", () => {
    const p = parseMobileV2LoaderPolicy({
      actions: [
        { key: "ok", label: "Ok", icon: "package" },
        { key: "no-label" },
        null,
      ],
      enabled_actions: ["ok"],
    });
    expect(p.actions.map((a) => a.key)).toEqual(["ok"]);
  });

  test("invalid version / negative threshold fall back to defaults", () => {
    const p = parseMobileV2LoaderPolicy({ version: -1, confirm_threshold: -5 });
    expect(p.version).toBe(MOBILE_V2_LOADER_DEFAULT_POLICY.version);
    expect(p.confirmThreshold).toBe(MOBILE_V2_LOADER_DEFAULT_POLICY.confirmThreshold);
  });

  test("dedupes context_chips while preserving order", () => {
    const p = parseMobileV2LoaderPolicy({ context_chips: ["route", "route", "bay"] });
    expect(p.contextChips).toEqual(["route", "bay"]);
  });

  test("empty actions array falls back to default actions", () => {
    const p = parseMobileV2LoaderPolicy({ actions: [] });
    expect(p.actions).toEqual(MOBILE_V2_LOADER_DEFAULT_POLICY.actions);
  });
});

describe("getEnabledLoaderActions", () => {
  test("returns intersection of catalog and enabled keys", () => {
    const p = parseMobileV2LoaderPolicy({
      ...FULL_POLICY,
      enabled_actions: ["load", "verify"],
    });
    const enabled = getEnabledLoaderActions(p);
    expect(enabled.map((a) => a.key)).toEqual(["load", "verify"]);
  });

  test("preserves catalog order regardless of enabled_actions order", () => {
    const p = parseMobileV2LoaderPolicy({
      ...FULL_POLICY,
      enabled_actions: ["verify", "load"],
    });
    const enabled = getEnabledLoaderActions(p);
    // Catalog order: load(0), unload(1), ..., verify(4)
    expect(enabled.map((a) => a.key)).toEqual(["load", "verify"]);
  });
});

describe("shouldConfirmLoaderBulkSubmit", () => {
  const policy = parseMobileV2LoaderPolicy(FULL_POLICY); // confirm_threshold = 25

  test("single-mode never confirms", () => {
    expect(shouldConfirmLoaderBulkSubmit(policy, { scanCount: 1000, mode: "single" })).toBe(false);
  });

  test("bulk under threshold does not confirm", () => {
    expect(shouldConfirmLoaderBulkSubmit(policy, { scanCount: 25, mode: "bulk" })).toBe(false);
    expect(shouldConfirmLoaderBulkSubmit(policy, { scanCount: 0, mode: "bulk" })).toBe(false);
  });

  test("bulk above threshold confirms", () => {
    expect(shouldConfirmLoaderBulkSubmit(policy, { scanCount: 26, mode: "bulk" })).toBe(true);
    expect(shouldConfirmLoaderBulkSubmit(policy, { scanCount: 1000, mode: "bulk" })).toBe(true);
  });
});

describe("isLoaderActionEnabled / resolveEffectiveLoaderAction", () => {
  const policy = parseMobileV2LoaderPolicy(FULL_POLICY);

  test("isLoaderActionEnabled hits + misses", () => {
    expect(isLoaderActionEnabled(policy, "load")).toBe(true);
    expect(isLoaderActionEnabled(policy, "verify")).toBe(false); // not in enabled_actions
  });

  test("resolveEffectiveLoaderAction respects valid request", () => {
    expect(resolveEffectiveLoaderAction(policy, "sort")).toBe("sort");
  });

  test("resolveEffectiveLoaderAction falls back to default when request invalid", () => {
    expect(resolveEffectiveLoaderAction(policy, "imaginary")).toBe("sort");
    expect(resolveEffectiveLoaderAction(policy, null)).toBe("sort");
    expect(resolveEffectiveLoaderAction(policy, undefined)).toBe("sort");
  });

  test("resolveEffectiveLoaderAction falls back to first enabled when default invalid", () => {
    const altPolicy = parseMobileV2LoaderPolicy({
      ...FULL_POLICY,
      enabled_actions: ["sort", "receive"],
      default_action: "load", // not in enabled set
    });
    // default_action gets normalised to first enabled at parse time
    expect(altPolicy.defaultAction).toBe("sort");
    // even if caller passes the un-normalised string, fallback chain works
    expect(resolveEffectiveLoaderAction(altPolicy, "load")).toBe("sort");
  });
});

describe("getLoaderActionSubmitRpc", () => {
  const policy = parseMobileV2LoaderPolicy(FULL_POLICY);

  test("returns only the row-declared executor for submit-capable actions", () => {
    expect(getLoaderActionSubmitRpc(policy, "sort")).toBe("induct_fieldops_parcel_v1");
    expect(getLoaderActionSubmitRpc(policy, "receive")).toBeNull();
  });

  test("falls back through the effective action before resolving submit RPC", () => {
    expect(getLoaderActionSubmitRpc(policy, "imaginary")).toBe("induct_fieldops_parcel_v1");
  });
});
