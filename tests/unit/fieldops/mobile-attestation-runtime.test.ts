import { normalizeMobileAttestationPolicy } from "../../../apps/fieldops/src/mobile-attestation-policy";
import { resolveMobileAttestationRuntimeGate } from "../../../apps/fieldops/src/mobile-attestation-runtime";

type RuntimeInput = Parameters<typeof resolveMobileAttestationRuntimeGate>[0];

function policy(mode: "enforce" | "monitor" | "off", overrides: Record<string, unknown> = {}) {
  return normalizeMobileAttestationPolicy({
    enabled: true,
    mode,
    enforce_rpcs: ["record_scan_event_v1", "register_user_device_v1", "record_location_ping_v1"],
    android_cloud_project_number: "101",
    ...overrides,
  });
}

function gate(overrides: Partial<RuntimeInput> = {}) {
  return resolveMobileAttestationRuntimeGate({
    policy: policy("enforce"),
    rpcName: "record_scan_event_v1",
    source: "mobile",
    online: true,
    platform: "android",
    isDevice: true,
    appIntegrityAvailable: true,
    ...overrides,
  });
}

test.each([
  ["enforce", { shouldBuild: true, enforce: true, reason: "required" }],
  ["monitor", { shouldBuild: true, enforce: false, reason: "required" }],
  ["off", { shouldBuild: false, enforce: false, reason: "not_required" }],
] as const)("applies %s mode to protected RPCs", (mode, expected) => {
  expect(gate({ policy: policy(mode) })).toEqual({ ...expected, failureMessage: null });
});

test("exempts background writes only when policy enables it", () => {
  expect(gate({ rpcName: "unprotected_rpc" }).reason).toBe("not_required");
  const background = { rpcName: "record_location_ping_v1", source: "mobile_background" };
  const enabled = policy("enforce", { allow_background_without_attestation: true });
  expect(gate({ ...background, policy: enabled, online: false })).toEqual({
    shouldBuild: false, enforce: false, reason: "background_allowed", failureMessage: null,
  });
  const disabled = policy("enforce", { allow_background_without_attestation: false });
  expect(gate({ ...background, policy: disabled }).reason).toBe("required");
  expect(gate({ policy: enabled }).shouldBuild).toBe(true);
});

const unavailable: Array<[Partial<RuntimeInput>, string]> = [
  [{ online: false }, "offline"],
  [{ platform: "web" }, "native_required"],
  [{ isDevice: false }, "device_required"],
  [{ platform: "unsupported" }, "platform_unsupported"],
  [{ appIntegrityAvailable: false }, "integrity_unavailable"],
  [{ platform: "ios", iosAppAttestSupported: false }, "ios_unsupported"],
];

test.each(unavailable)("classifies runtime input %j as %s", (input, reason) => {
  expect(gate(input)).toEqual({
    shouldBuild: false, enforce: true, reason, failureMessage: expect.any(String),
  });
  expect(gate({ ...input, policy: policy("monitor") })).toEqual({
    shouldBuild: false, enforce: false, reason, failureMessage: null,
  });
});

test("requires a positive Android project number before building proof", () => {
  for (const value of [null, "", " ", "0", "-1", "invalid"]) {
    const overrides = { android_cloud_project_number: value };
    expect(gate({ policy: policy("enforce", overrides) }).reason).toBe("android_project_missing");
    expect(gate({ policy: policy("monitor", overrides) })).toEqual({
      shouldBuild: false, enforce: false, reason: "android_project_missing", failureMessage: null,
    });
  }
  expect(gate({ policy: policy("enforce", { android_cloud_project_number: " 202 " }) }).shouldBuild).toBe(true);
});
