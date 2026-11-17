import {
  DEFAULT_MOBILE_PUSH_POLICY,
  normalizeMobilePushPolicy,
  resolveExpoProjectIdFromConstants,
} from "../../../apps/fieldops/src/mobile-push-policy";

describe("mobile push policy helpers", () => {
  test("normalizeMobilePushPolicy returns safe defaults", () => {
    expect(normalizeMobilePushPolicy(null)).toEqual(DEFAULT_MOBILE_PUSH_POLICY);
    expect(normalizeMobilePushPolicy({})).toEqual(DEFAULT_MOBILE_PUSH_POLICY);
  });

  test("normalizeMobilePushPolicy maps configured values", () => {
    const next = normalizeMobilePushPolicy({
      enabled: true,
      register_on_startup: false,
      request_permission: false,
      emit_log_events: false,
      provider: "EXPO",
      default_channel_id: "ops-critical",
      default_channel_name: "Ops Critical Alerts",
    });

    expect(next).toEqual({
      enabled: true,
      registerOnStartup: false,
      requestPermission: false,
      emitLogEvents: false,
      provider: "expo",
      defaultChannelId: "ops-critical",
      defaultChannelName: "Ops Critical Alerts",
    });
  });

  test("normalizeMobilePushPolicy ignores invalid value types", () => {
    const next = normalizeMobilePushPolicy({
      enabled: "true",
      register_on_startup: 1,
      request_permission: [],
      emit_log_events: {},
      provider: "   ",
      default_channel_id: 123,
      default_channel_name: "",
    });

    expect(next).toEqual(DEFAULT_MOBILE_PUSH_POLICY);
  });

  test("resolveExpoProjectIdFromConstants prefers easConfig project id", () => {
    const projectId = resolveExpoProjectIdFromConstants({
      easConfig: { projectId: "d8792c14-ef3d-46fb-8d66-0f86a46426c6" },
      expoConfig: { extra: { eas: { projectId: "e753e202-8302-4c67-ac1c-4c258da46fda" } } },
    });

    expect(projectId).toBe("d8792c14-ef3d-46fb-8d66-0f86a46426c6");
  });

  test("resolveExpoProjectIdFromConstants falls back to expo extra eas project id", () => {
    const projectId = resolveExpoProjectIdFromConstants({
      expoConfig: { extra: { eas: { projectId: "e753e202-8302-4c67-ac1c-4c258da46fda" } } },
    });

    expect(projectId).toBe("e753e202-8302-4c67-ac1c-4c258da46fda");
  });

  test("resolveExpoProjectIdFromConstants returns null when missing", () => {
    expect(resolveExpoProjectIdFromConstants({})).toBeNull();
    expect(
      resolveExpoProjectIdFromConstants({
        easConfig: { projectId: "  " },
        expoConfig: { extra: { eas: { projectId: "" } } },
      })
    ).toBeNull();
  });
});

