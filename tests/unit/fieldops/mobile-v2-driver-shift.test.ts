import {
  buildMobileV2OpsSessionReadbackInput,
  buildMobileV2EndDriverShiftInput,
  buildMobileV2StartDriverShiftInput,
  mobileV2DriverShiftCloseMatchesReadback,
  mobileV2DriverShiftReadinessAllowsStart,
  mobileV2DriverShiftStartMatchesReadback,
  parseMobileV2OpsSessionReadback,
  readMobileV2ActiveDriverShift,
} from "../../../apps/fieldops/src/mobile-v2-driver-shift";

describe("readMobileV2ActiveDriverShift", () => {
  test("parses persisted active shift state", () => {
    expect(
      readMobileV2ActiveDriverShift(
        JSON.stringify({
          opsSessionId: "3777c339-7366-4a7e-9d90-6638aa40bea8",
          openedAt: "2026-05-25T13:23:16.859Z",
        }),
      ),
    ).toEqual({
      opsSessionId: "3777c339-7366-4a7e-9d90-6638aa40bea8",
      openedAt: "2026-05-25T13:23:16.859Z",
    });
  });

  test("rejects blank, malformed, and id-less state", () => {
    expect(readMobileV2ActiveDriverShift(null)).toBeNull();
    expect(readMobileV2ActiveDriverShift("   ")).toBeNull();
    expect(readMobileV2ActiveDriverShift("{bad-json")).toBeNull();
    expect(readMobileV2ActiveDriverShift(JSON.stringify({ openedAt: "2026-05-25T13:23:16.859Z" }))).toBeNull();
  });
});

describe("buildMobileV2StartDriverShiftInput", () => {
  test("builds canonical open_ops_session_v1 driver shift input", () => {
    expect(
      buildMobileV2StartDriverShiftInput({
        deviceId: "a962fe30-f405-4386-8e49-996359c72045",
        openedAt: "2026-05-25T13:23:16.859Z",
      }),
    ).toEqual({
      session_type: "driver_shift",
      device_id: "a962fe30-f405-4386-8e49-996359c72045",
      opened_at: "2026-05-25T13:23:16.859Z",
      idempotency_key: "driver-shift-a962fe30-f405-4386-8e49-996359c72045-2026-05-25T13:23:16.859Z",
      metadata: {
        app: "fieldops",
        surface: "mobile_v2_more",
        source: "mobile_v2_native_shell",
      },
    });
  });
});

describe("buildMobileV2EndDriverShiftInput", () => {
  test("builds canonical transition_ops_session_v1 close input", () => {
    expect(
      buildMobileV2EndDriverShiftInput({
        opsSessionId: "3777c339-7366-4a7e-9d90-6638aa40bea8",
        effectiveAt: "2026-05-25T13:27:46.447Z",
      }),
    ).toEqual({
      ops_session_id: "3777c339-7366-4a7e-9d90-6638aa40bea8",
      to_status: "closed",
      set_closed_at: true,
      effective_at: "2026-05-25T13:27:46.447Z",
      idempotency_key: "driver-shift-close-3777c339-7366-4a7e-9d90-6638aa40bea8-2026-05-25T13:27:46.447Z",
      payload: {
        app: "fieldops",
        surface: "mobile_v2_more",
        source: "mobile_v2_native_shell",
      },
    });
  });
});

describe("Mobile V2 driver-shift backend readback", () => {
  const openRow = {
    id: "3777c339-7366-4a7e-9d90-6638aa40bea8",
    session_type: "driver_shift",
    status: "open",
    device_id: "a962fe30-f405-4386-8e49-996359c72045",
    actor_user_id: "5456be0e-0cd3-4fb2-8d92-5ed5e503de60",
    opened_at: "2026-05-25T13:23:16.859Z",
    closed_at: null,
    version: 1,
  };

  test("builds registry-driven ops session readback input", () => {
    expect(buildMobileV2OpsSessionReadbackInput(openRow.id)).toEqual({
      p_resource: "ops_sessions",
      p_id: "3777c339-7366-4a7e-9d90-6638aa40bea8",
    });
  });

  test("parses registry row readback without fixture substitution", () => {
    expect(parseMobileV2OpsSessionReadback(openRow)).toEqual({
      opsSessionId: "3777c339-7366-4a7e-9d90-6638aa40bea8",
      sessionType: "driver_shift",
      status: "open",
      deviceId: "a962fe30-f405-4386-8e49-996359c72045",
      actorUserId: "5456be0e-0cd3-4fb2-8d92-5ed5e503de60",
      openedAt: "2026-05-25T13:23:16.859Z",
      closedAt: null,
      version: 1,
    });
    expect(parseMobileV2OpsSessionReadback(null)).toBeNull();
    expect(parseMobileV2OpsSessionReadback({ id: openRow.id, status: "open" })).toBeNull();
  });

  test("accepts start success only after same-session open backend readback", () => {
    const readback = parseMobileV2OpsSessionReadback(openRow);
    expect(
      mobileV2DriverShiftStartMatchesReadback(readback, {
        opsSessionId: openRow.id,
        deviceId: openRow.device_id,
      }),
    ).toBe(true);

    expect(
      mobileV2DriverShiftStartMatchesReadback(
        parseMobileV2OpsSessionReadback({ ...openRow, status: "closed" }),
        { opsSessionId: openRow.id, deviceId: openRow.device_id },
      ),
    ).toBe(false);
    expect(
      mobileV2DriverShiftStartMatchesReadback(readback, {
        opsSessionId: openRow.id,
        deviceId: "0cde837d-9238-44cd-ae1a-7cb5ca3d2a1b",
      }),
    ).toBe(false);
  });

  test("accepts close success only after closed backend readback with closed_at", () => {
    expect(
      mobileV2DriverShiftCloseMatchesReadback(
        parseMobileV2OpsSessionReadback({
          ...openRow,
          status: "closed",
          closed_at: "2026-05-25T13:27:46.447Z",
          version: "2",
        }),
        { opsSessionId: openRow.id },
      ),
    ).toBe(true);

    expect(
      mobileV2DriverShiftCloseMatchesReadback(
        parseMobileV2OpsSessionReadback({ ...openRow, status: "closed", closed_at: null }),
        { opsSessionId: openRow.id },
      ),
    ).toBe(false);
    expect(
      mobileV2DriverShiftCloseMatchesReadback(parseMobileV2OpsSessionReadback(openRow), {
        opsSessionId: openRow.id,
      }),
    ).toBe(false);
  });
});

describe("Mobile V2 driver-shift readiness gate", () => {
  test("fails closed until documents, vehicle, photos, cleaning, and pre-shift are ready", () => {
    expect(mobileV2DriverShiftReadinessAllowsStart(undefined)).toBe(false);
    expect(
      mobileV2DriverShiftReadinessAllowsStart({
        docsComplete: true,
        vehicleSubmitted: true,
        vehiclePhotosSubmitted: true,
        cleaningAttested: false,
        cleaningRequired: true,
        preShiftCleared: true,
      }),
    ).toBe(false);
    expect(
      mobileV2DriverShiftReadinessAllowsStart({
        docsComplete: true,
        vehicleSubmitted: true,
        vehiclePhotosSubmitted: true,
        cleaningAttested: false,
        cleaningRequired: false,
        preShiftCleared: false,
      }),
    ).toBe(false);
    expect(
      mobileV2DriverShiftReadinessAllowsStart({
        docsComplete: true,
        vehicleSubmitted: true,
        vehiclePhotosSubmitted: true,
        cleaningAttested: false,
        cleaningRequired: false,
        preShiftCleared: true,
      }),
    ).toBe(true);
    expect(
      mobileV2DriverShiftReadinessAllowsStart({
        docsComplete: true,
        vehicleSubmitted: true,
        vehiclePhotosSubmitted: true,
        cleaningAttested: true,
        cleaningRequired: true,
        preShiftCleared: false,
      }),
    ).toBe(false);
    expect(
      mobileV2DriverShiftReadinessAllowsStart({
        docsComplete: true,
        vehicleSubmitted: true,
        vehiclePhotosSubmitted: true,
        cleaningAttested: true,
        cleaningRequired: true,
        preShiftCleared: true,
      }),
    ).toBe(true);
  });
});
