import {
  mapFieldopsCashDropEnvelope,
  mobileV2CashDropMatchesWrite,
  type MobileV2CashDropEnvelope,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import {
  buildMobileV2CashDropEvidenceStorageKey,
} from "../../../apps/fieldops/src/mobile-v2-pod-artifacts";

const FALLBACK: MobileV2CashDropEnvelope = Object.freeze({
  expectedSar: 1240,
  safeLocation: "Fallback safe",
  lastDrop: null,
});

describe("mapFieldopsCashDropEnvelope", () => {
  test("maps latest_drop into the Mobile V2 same-screen readback contract", () => {
    const envelope = mapFieldopsCashDropEnvelope(
      {
        expected_sar: "137",
        safe_location: "Hub safe A",
        latest_drop: {
          decision_log_id: "00000000-1111-4222-8333-444444444444",
          state: "balanced",
          expected_sar: 137,
          actual_sar: "137",
          variance_sar: "0",
          supervisor_name: "",
          submitted_at: "2026-05-27T09:30:00Z",
        },
      },
      FALLBACK,
    );

    expect(envelope.expectedSar).toBe(137);
    expect(envelope.safeLocation).toBe("Hub safe A");
    expect(envelope.lastDrop).toEqual({
      decisionLogId: "00000000-1111-4222-8333-444444444444",
      state: "balanced",
      expectedSar: 137,
      actualSar: 137,
      varianceSar: 0,
      supervisorName: null,
      submittedAt: "2026-05-27T09:30:00Z",
      photoId: null,
      photoArtifactRegistered: null,
      photoStorageKey: null,
    });
  });

  test("maps non-zero variance photo artifact readback for same-screen proof", () => {
    const envelope = mapFieldopsCashDropEnvelope(
      {
        expected_sar: 137,
        safe_location: "Hub safe A",
        latest_drop: {
          decision_log_id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
          state: "variance",
          expected_sar: 137,
          actual_sar: 127,
          variance_sar: -10,
          supervisor_name: "Cashier Proof",
          photo_id: "22222222-2222-4222-8222-222222222222",
          photo_artifact_registered: true,
          photo_storage_key: "org/cash-drop/envelope-proof.jpg",
          submitted_at: "2026-05-29T09:30:00Z",
        },
      },
      FALLBACK,
    );

    expect(envelope.lastDrop).toEqual({
      decisionLogId: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
      state: "variance",
      expectedSar: 137,
      actualSar: 127,
      varianceSar: -10,
      supervisorName: "Cashier Proof",
      submittedAt: "2026-05-29T09:30:00Z",
      photoId: "22222222-2222-4222-8222-222222222222",
      photoArtifactRegistered: true,
      photoStorageKey: "org/cash-drop/envelope-proof.jpg",
    });
  });

  test("does not replace malformed live fields with fixture business readback", () => {
    const envelope = mapFieldopsCashDropEnvelope(
      {
        expected_sar: null,
        safe_location: "",
        latest_drop: {
          state: "balanced",
          actual_sar: 137,
        },
      },
      FALLBACK,
    );

    expect(envelope.expectedSar).toBe(FALLBACK.expectedSar);
    expect(envelope.safeLocation).toBe(FALLBACK.safeLocation);
    expect(envelope.lastDrop).toBeNull();
  });

  test("requires matching backend decision, amounts, and variance artifact for submitted readback", () => {
    const write = {
      ok: true as const,
      state: "variance",
      decision_log_id: "33333333-3333-4333-8333-333333333333",
    };
    const latestDrop = {
      decisionLogId: "33333333-3333-4333-8333-333333333333",
      state: "variance",
      expectedSar: 137,
      actualSar: 127,
      varianceSar: -10,
      supervisorName: "Cashier Proof",
      submittedAt: "2026-05-29T09:30:00Z",
      photoId: "44444444-4444-4444-8444-444444444444",
      photoArtifactRegistered: true,
      photoStorageKey: "org/cash-drop/envelope-proof.jpg",
    };

    expect(
      mobileV2CashDropMatchesWrite(
        latestDrop,
        write,
        137,
        127,
        "44444444-4444-4444-8444-444444444444",
      ),
    ).toBe(true);
    expect(
      mobileV2CashDropMatchesWrite(
        { ...latestDrop, actualSar: 126, varianceSar: -11 },
        write,
        137,
        127,
        "44444444-4444-4444-8444-444444444444",
      ),
    ).toBe(false);
    expect(
      mobileV2CashDropMatchesWrite(
        { ...latestDrop, photoArtifactRegistered: false },
        write,
        137,
        127,
        "44444444-4444-4444-8444-444444444444",
      ),
    ).toBe(false);
  });

  test("builds scoped cash-drop envelope evidence storage keys", () => {
    expect(
      buildMobileV2CashDropEvidenceStorageKey({
        organizationId: "org-123",
        uniqueId: "Variance Proof 1",
        extension: ".JPG",
      }),
    ).toBe("org-123/cash-drop/envelope-variance-proof-1.jpg");
  });
});
