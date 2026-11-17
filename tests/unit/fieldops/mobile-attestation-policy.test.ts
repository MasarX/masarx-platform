import {
  DEFAULT_MOBILE_ATTESTATION_POLICY,
  normalizeMobileAttestationPolicy,
  shouldEnforceAttestationForRpc,
} from "../../../apps/fieldops/src/mobile-attestation-policy";

describe("mobile attestation policy helpers", () => {
  test("normalizeMobileAttestationPolicy returns safe defaults", () => {
    expect(normalizeMobileAttestationPolicy(null)).toEqual(DEFAULT_MOBILE_ATTESTATION_POLICY);
    expect(normalizeMobileAttestationPolicy({})).toEqual(DEFAULT_MOBILE_ATTESTATION_POLICY);
  });

  test("normalizeMobileAttestationPolicy maps configured values", () => {
    const next = normalizeMobileAttestationPolicy({
      enabled: true,
      mode: "enforce",
      enforce_rpcs: ["record_scan_event_v1", "record_location_ping_v1"],
      allowed_providers: ["android_play_integrity"],
      max_age_seconds: 180,
      challenge_ttl_seconds: 90,
      allow_background_without_attestation: false,
      android_cloud_project_number: "1234567890",
    });

    expect(next).toEqual({
      enabled: true,
      mode: "enforce",
      enforceRpcs: ["record_scan_event_v1", "record_location_ping_v1"],
      allowedProviders: ["android_play_integrity"],
      maxAgeSeconds: 180,
      challengeTtlSeconds: 90,
      allowBackgroundWithoutAttestation: false,
      androidCloudProjectNumber: "1234567890",
    });
  });

  test("normalizeMobileAttestationPolicy ignores invalid value types", () => {
    const next = normalizeMobileAttestationPolicy({
      enabled: "true",
      mode: "invalid",
      enforce_rpcs: [1, {}, ""],
      allowed_providers: ["unknown"],
      max_age_seconds: "100",
      challenge_ttl_seconds: 9,
      allow_background_without_attestation: "false",
      android_cloud_project_number: "  ",
    });

    expect(next).toEqual(DEFAULT_MOBILE_ATTESTATION_POLICY);
  });

  test("shouldEnforceAttestationForRpc follows policy mode + rpc list", () => {
    expect(
      shouldEnforceAttestationForRpc(DEFAULT_MOBILE_ATTESTATION_POLICY, "record_scan_event_v1")
    ).toBe(false);

    const policy = normalizeMobileAttestationPolicy({
      enabled: true,
      mode: "monitor",
      enforce_rpcs: ["record_scan_event_v1"],
    });

    expect(shouldEnforceAttestationForRpc(policy, "record_scan_event_v1")).toBe(true);
    expect(shouldEnforceAttestationForRpc(policy, "register_user_device_v1")).toBe(false);
  });
});
