import {
  MOBILE_V2_DAMAGE_HOLD_DEFAULT_POLICY,
  parseMobileV2DamageHoldPolicy,
} from "../../../apps/fieldops/src/mobile-v2-damage-hold-policy";
import {
  mapFieldopsLatestDamageHoldEnvelope,
  mobileV2DamageHoldMatchesWrite,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";

describe("Mobile V2 damage-hold policy", () => {
  test("maps row-driven severities and drops invalid rows", () => {
    const policy = parseMobileV2DamageHoldPolicy({
      version: 2,
      severities: [
        { id: "crushed", label: "Crushed", color: "danger" },
        { id: "bad", label: "Bad", color: "purple" },
        { id: "", label: "Missing", color: "warning" },
      ],
    });

    expect(policy).toEqual({
      version: 2,
      severities: [{ id: "crushed", label: "Crushed", color: "danger" }],
    });
  });

  test("falls back only when policy shape is unusable", () => {
    expect(parseMobileV2DamageHoldPolicy(null)).toEqual(MOBILE_V2_DAMAGE_HOLD_DEFAULT_POLICY);
    expect(parseMobileV2DamageHoldPolicy({ severities: [] })).toEqual(MOBILE_V2_DAMAGE_HOLD_DEFAULT_POLICY);
  });
});

describe("Mobile V2 damage-hold readback", () => {
  test("maps latest_damage_hold into the same-screen readback contract", () => {
    const readback = mapFieldopsLatestDamageHoldEnvelope({
      latest_damage_hold: {
        hold_id: "11111111-2222-4333-8444-555555555555",
        decision_log_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        parcel_id: "99999999-8888-4777-8666-555555555555",
        severity_id: "crushed",
        note: "Crushed corner and leaking contents",
        photo_storage_path: "damage-hold/proof.jpg",
        state: "open",
        submitted_at: "2026-05-29T13:20:00Z",
      },
    });

    expect(readback).toEqual({
      holdId: "11111111-2222-4333-8444-555555555555",
      decisionLogId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      parcelId: "99999999-8888-4777-8666-555555555555",
      severityId: "crushed",
      note: "Crushed corner and leaking contents",
      photoPath: "damage-hold/proof.jpg",
      state: "open",
      submittedAt: "2026-05-29T13:20:00Z",
    });
  });

  test("does not fabricate readback when required backend fields are missing", () => {
    expect(
      mapFieldopsLatestDamageHoldEnvelope({
        latest_damage_hold: {
          severity_id: "crushed",
          state: "open",
        },
      }),
    ).toBeNull();
  });

  test("accepts visible success only when latest readback matches the write decision", () => {
    const write = {
      ok: true as const,
      decision_log_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      hold_id: "11111111-2222-4333-8444-555555555555",
      state: "open",
    };

    expect(
      mobileV2DamageHoldMatchesWrite(
        {
          holdId: "11111111-2222-4333-8444-555555555555",
          decisionLogId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          parcelId: "99999999-8888-4777-8666-555555555555",
          severityId: "crushed",
          note: "Crushed corner and leaking contents",
          photoPath: "damage-hold/proof.jpg",
          state: "open",
          submittedAt: "2026-05-29T13:20:00Z",
        },
        write,
        "99999999-8888-4777-8666-555555555555",
        "crushed",
        "Crushed corner and leaking contents",
        "damage-hold/proof.jpg",
      ),
    ).toBe(true);

    expect(
      mobileV2DamageHoldMatchesWrite(
        {
          holdId: "11111111-2222-4333-8444-555555555555",
          decisionLogId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          parcelId: "99999999-8888-4777-8666-555555555555",
          severityId: "wet",
          note: "Crushed corner and leaking contents",
          photoPath: "damage-hold/proof.jpg",
          state: "open",
          submittedAt: "2026-05-29T13:20:00Z",
        },
        write,
        "99999999-8888-4777-8666-555555555555",
        "crushed",
        "Crushed corner and leaking contents",
        "damage-hold/proof.jpg",
      ),
    ).toBe(false);

    expect(
      mobileV2DamageHoldMatchesWrite(
        {
          holdId: "99999999-2222-4333-8444-555555555555",
          decisionLogId: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          parcelId: "99999999-8888-4777-8666-555555555555",
          severityId: "crushed",
          note: "Older hold still cached by latest readback",
          photoPath: "damage-hold/proof.jpg",
          state: "open",
          submittedAt: "2026-05-29T13:10:00Z",
        },
        write,
        "99999999-8888-4777-8666-555555555555",
        "crushed",
        "Crushed corner and leaking contents",
        "damage-hold/proof.jpg",
      ),
    ).toBe(false);
  });
});
