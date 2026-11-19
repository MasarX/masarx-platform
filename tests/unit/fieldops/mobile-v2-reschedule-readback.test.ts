import type { MobileV2StopDetail } from "../../../apps/fieldops/src/mobile-v2-stop-screen";
import {
  MOBILE_V2_RESCHEDULE_DEFAULT_POLICY,
  buildMobileV2RescheduleReadback,
  buildMobileV2RescheduleWindows,
  mobileV2StopDetailMatchesRescheduleWindow,
  parseMobileV2ReschedulePolicy,
} from "../../../apps/fieldops/src/mobile-v2-reschedule-policy";

describe("Mobile V2 reschedule policy", () => {
  test("maps row-driven offsets and warm window minutes", () => {
    const policy = parseMobileV2ReschedulePolicy({
      version: 3,
      default_reschedule_offsets: ["P1D", "bad", "P2D", "P1D", "P0D"],
      warm_window_minutes: 120,
    });

    expect(policy).toEqual({
      version: 3,
      defaultRescheduleOffsets: ["P1D", "P2D"],
      warmWindowMinutes: 120,
      timeZone: "Asia/Riyadh",
    });
  });

  test("uses backend-provided timezone when present", () => {
    const policy = parseMobileV2ReschedulePolicy({
      version: 1,
      default_reschedule_offsets: ["P1D"],
      warm_window_minutes: 60,
      time_zone: "Europe/London",
    });

    expect(policy.timeZone).toBe("Europe/London");
  });

  test("falls back only when policy shape is unusable", () => {
    expect(parseMobileV2ReschedulePolicy(null)).toEqual(MOBILE_V2_RESCHEDULE_DEFAULT_POLICY);
    expect(parseMobileV2ReschedulePolicy({ default_reschedule_offsets: [] })).toEqual(
      MOBILE_V2_RESCHEDULE_DEFAULT_POLICY,
    );
  });
});

describe("Mobile V2 reschedule windows", () => {
  test("builds backend TIMESTAMPTZ payloads from the active stop window", () => {
    const windows = buildMobileV2RescheduleWindows({
      policy: {
        version: 1,
        defaultRescheduleOffsets: ["P1D", "P2D"],
        warmWindowMinutes: 120,
        timeZone: "Asia/Riyadh",
      },
      currentWindow: "09:15",
      now: new Date("2026-05-29T00:00:00.000Z"),
    });

    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      id: "P1D-0915-1115",
      label: "Tomorrow - 09:15-11:15",
      startIso: "2026-05-30T06:15:00.000Z",
      endIso: "2026-05-30T08:15:00.000Z",
      fit: "good",
      recommendedReason: "Recommended by delivery slot policy",
    });
    expect(windows[1]).toMatchObject({
      id: "P2D-0915-1115",
      label: "Day after - 09:15-11:15",
      startIso: "2026-05-31T06:15:00.000Z",
      endIso: "2026-05-31T08:15:00.000Z",
      fit: "ok",
    });
  });

  test("does not fabricate windows when the stop window is missing", () => {
    expect(
      buildMobileV2RescheduleWindows({
        policy: MOBILE_V2_RESCHEDULE_DEFAULT_POLICY,
        currentWindow: "not scheduled",
        now: new Date("2026-05-29T00:00:00.000Z"),
      }),
    ).toEqual([]);
  });

  test("bases tomorrow on the Riyadh calendar day, not raw UTC", () => {
    const [window] = buildMobileV2RescheduleWindows({
      policy: {
        version: 1,
        defaultRescheduleOffsets: ["P1D"],
        warmWindowMinutes: 60,
        timeZone: "Asia/Riyadh",
      },
      currentWindow: "10:00",
      now: new Date("2026-05-29T22:30:00.000Z"),
    });

    expect(window).toMatchObject({
      label: "Tomorrow - 10:00-11:00",
      startIso: "2026-05-31T07:00:00.000Z",
      endIso: "2026-05-31T08:00:00.000Z",
    });
  });
});

describe("Mobile V2 reschedule readback", () => {
  test("matches visible stop-detail readback to the selected policy window", () => {
    const [window] = buildMobileV2RescheduleWindows({
      policy: {
        version: 1,
        defaultRescheduleOffsets: ["P1D"],
        warmWindowMinutes: 90,
        timeZone: "Asia/Riyadh",
      },
      currentWindow: "15:30",
      now: new Date("2026-05-29T00:00:00.000Z"),
    });

    expect(window).toBeDefined();
    expect(
      mobileV2StopDetailMatchesRescheduleWindow({ window: "15:30" } as MobileV2StopDetail, window!),
    ).toBe(true);
    expect(
      mobileV2StopDetailMatchesRescheduleWindow({ window: "09:00" } as MobileV2StopDetail, window!),
    ).toBe(false);
  });

  test("requires backend decision lineage before surfacing success", () => {
    const [window] = buildMobileV2RescheduleWindows({
      policy: {
        version: 1,
        defaultRescheduleOffsets: ["P1D"],
        warmWindowMinutes: 90,
        timeZone: "Asia/Riyadh",
      },
      currentWindow: "15:30",
      now: new Date("2026-05-29T00:00:00.000Z"),
    });

    expect(
      buildMobileV2RescheduleReadback({
        write: {
          ok: true,
          decision_log_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          state: "rescheduled",
        },
        window: window!,
        note: "Customer requested later delivery",
        submittedAt: "2026-05-29T12:00:00.000Z",
      }),
    ).toEqual({
      decisionLogId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      state: "rescheduled",
      windowLabel: "15:30",
      note: "Customer requested later delivery",
      submittedAt: "2026-05-29T12:00:00.000Z",
    });

    expect(
      buildMobileV2RescheduleReadback({
        write: {
          ok: true,
          decision_log_id: "",
          state: "rescheduled",
        },
        window: window!,
        note: null,
      }),
    ).toBeNull();
  });
});
