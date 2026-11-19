import {
  mapFieldopsOnboardingReadbackEnvelope,
  mobileV2CleaningMatchesWrite,
  mobileV2KycDocMatchesWrite,
  mobileV2KycVehicleMatchesWrite,
  mobileV2PreShiftReadbackConfirmsHealthOk,
  mobileV2PreShiftMatchesWrite,
  mobileV2VehiclePhotosMatchWrite,
  type MobileV2WriteEnvelope,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";

const write = (decisionLogId: string, extra: Record<string, unknown> = {}): MobileV2WriteEnvelope => ({
  ...extra,
  ok: true,
  decision_log_id: decisionLogId,
});

describe("Mobile V2 onboarding readback mapping", () => {
  it("maps backend onboarding envelope fields without fixture fallbacks", () => {
    const envelope = mapFieldopsOnboardingReadbackEnvelope({
      active_role: "driver",
      organization_id: "org-1",
      user_id: "user-1",
      shift_id: "shift-1",
      documents: [
        {
          doc_id: "doc-1",
          doc_key: "national_id",
          status: "uploaded",
          state: "verified",
          decision_log_id: "dec-doc",
          storage_path: "kyc/id.jpg",
          submitted_at: "2026-05-28T08:00:00Z",
        },
      ],
      latest_vehicle: {
        vehicle_id: "veh-1",
        plate: "ABC-123",
        vin: "VIN-1",
        year: "2026",
        model: "Hiace",
        status: "submitted",
        state: "submitted",
        decision_log_id: "dec-vehicle",
      },
      latest_vehicle_photos: {
        photo_set_id: "photos-1",
        angle_paths: {
          front: "vehicle/front.jpg",
          rear: "vehicle/rear.jpg",
          left: "vehicle/left.jpg",
          right: "vehicle/right.jpg",
        },
        captured_angle_ids: ["front", "rear", "left", "right"],
        photo_count: 4,
        state: "submitted",
        decision_log_id: "dec-photos",
      },
      latest_cleaning: {
        check_id: "clean-1",
        checked_ids: ["cabin", "cargo"],
        item_count: 2,
        photo_path: "org/cleaning/shift/photo.jpg",
        state: "attested",
        decision_log_id: "dec-clean",
      },
      latest_pre_shift: {
        pass_id: "pass-1",
        shift_id: "shift-1",
        health_ok: true,
        state: "cleared",
        decision_log_id: "dec-pre",
      },
      policy: {
        photo_cadence_hours: 168,
        cleaning_cadence_hours: 24,
        health_attestation: true,
        required_documents: ["national_id"],
        vehicle_photo_angles: ["front", "rear", "left", "right"],
        cleaning_items: [{ id: "cabin", label: "Cabin", sub: "Wipe down" }],
      },
      requirements: {
        docs_uploaded_count: 1,
        required_documents_count: 1,
        required_documents_satisfied_count: 1,
        docs_complete: true,
        vehicle_submitted: true,
        vehicle_photos_submitted: true,
        required_vehicle_photo_count: 4,
        cleaning_attested: true,
        pre_shift_cleared: true,
        cleaning_required: false,
      },
    });

    expect(envelope.documents).toHaveLength(1);
    expect(envelope.latestCleaning?.photoPath).toBe("org/cleaning/shift/photo.jpg");
    expect(envelope.latestVehiclePhotos?.photoCount).toBe(4);
    expect(envelope.latestPreShift?.state).toBe("cleared");
    expect(envelope.policy.vehiclePhotoAngles).toEqual(["front", "rear", "left", "right"]);
    expect(envelope.policy.cleaningItems[0]?.id).toBe("cabin");
    expect(envelope.requirements.requiredDocumentsCount).toBe(1);
    expect(envelope.requirements.requiredDocumentsSatisfiedCount).toBe(1);
    expect(envelope.requirements.docsComplete).toBe(true);
    expect(envelope.requirements.vehiclePhotosSubmitted).toBe(true);
    expect(envelope.requirements.requiredVehiclePhotoCount).toBe(4);
    expect(envelope.requirements.preShiftCleared).toBe(true);
  });

  it("matches cleaning writes only after backend readback returns the same decision and checked set", () => {
    const envelope = mapFieldopsOnboardingReadbackEnvelope({
      latest_cleaning: {
        check_id: "clean-1",
        checked_ids: ["cabin", "cargo"],
        item_count: 2,
        state: "attested",
        decision_log_id: "dec-clean",
      },
    });

    expect(
      mobileV2CleaningMatchesWrite(
        envelope.latestCleaning,
        write("dec-clean"),
        ["cabin", "cargo"],
      ),
    ).toBe(true);
    expect(
      mobileV2CleaningMatchesWrite(
        envelope.latestCleaning,
        write("dec-other"),
        ["cabin", "cargo"],
      ),
    ).toBe(false);
  });

  it("matches KYC document writes only after backend readback returns the same document and storage path", () => {
    const envelope = mapFieldopsOnboardingReadbackEnvelope({
      documents: [
        {
          doc_id: "doc-1",
          doc_key: "national_id",
          status: "uploaded",
          state: "uploaded",
          decision_log_id: "dec-doc",
          storage_path: "org/kyc-documents/id-doc/photo-1.jpg",
        },
      ],
    });

    expect(
      mobileV2KycDocMatchesWrite(
        envelope.documents,
        write("dec-doc"),
        "idDoc",
        "org/kyc-documents/id-doc/photo-1.jpg",
      ),
    ).toBe(true);
    expect(
      mobileV2KycDocMatchesWrite(
        envelope.documents,
        write("dec-doc"),
        "licenseDoc",
        "org/kyc-documents/id-doc/photo-1.jpg",
      ),
    ).toBe(false);
    expect(
      mobileV2KycDocMatchesWrite(
        envelope.documents,
        write("dec-other"),
        "idDoc",
        "org/kyc-documents/id-doc/photo-1.jpg",
      ),
    ).toBe(false);
  });

  it("matches vehicle writes only after backend readback returns the same Istimara evidence and fields", () => {
    const envelope = mapFieldopsOnboardingReadbackEnvelope({
      latest_vehicle: {
        vehicle_id: "veh-1",
        plate: "MXV-2048",
        vin: "MXFIELDOPS000001",
        year: "2026",
        model: "Toyota Hiace",
        status: "submitted",
        state: "submitted",
        decision_log_id: "dec-vehicle",
        istimara_path: "org/kyc-vehicle/istimara/photo-1.jpg",
      },
    });

    expect(
      mobileV2KycVehicleMatchesWrite(
        envelope.latestVehicle,
        write("dec-vehicle", { state: "submitted" }),
        {
          plate: "MXV-2048",
          vin: "MXFIELDOPS000001",
          year: "2026",
          model: "Toyota Hiace",
          istimaraPath: "org/kyc-vehicle/istimara/photo-1.jpg",
        },
      ),
    ).toBe(true);
    expect(
      mobileV2KycVehicleMatchesWrite(
        envelope.latestVehicle,
        write("dec-vehicle", { state: "submitted" }),
        {
          plate: "MXV-2048",
          vin: "MXFIELDOPS000001",
          year: "2026",
          model: "Toyota Hiace",
          istimaraPath: "org/kyc-vehicle/istimara/other.jpg",
        },
      ),
    ).toBe(false);
    expect(
      mobileV2KycVehicleMatchesWrite(
        envelope.latestVehicle,
        write("dec-other", { state: "submitted" }),
        {
          plate: "MXV-2048",
          vin: "MXFIELDOPS000001",
          year: "2026",
          model: "Toyota Hiace",
          istimaraPath: "org/kyc-vehicle/istimara/photo-1.jpg",
        },
      ),
    ).toBe(false);
  });

  it("matches vehicle photo writes only after backend readback returns all required angles", () => {
    const envelope = mapFieldopsOnboardingReadbackEnvelope({
      latest_vehicle_photos: {
        photo_set_id: "photos-1",
        angle_paths: {
          front: "vehicle/front.jpg",
          rear: "vehicle/rear.jpg",
          left: "vehicle/left.jpg",
          right: "vehicle/right.jpg",
        },
        captured_angle_ids: ["front", "rear", "left", "right"],
        photo_count: 4,
        state: "submitted",
        decision_log_id: "dec-photos",
      },
    });

    expect(
      mobileV2VehiclePhotosMatchWrite(
        envelope.latestVehiclePhotos,
        write("dec-photos", { state: "submitted" }),
        ["front", "rear", "left", "right"],
        {
          front: "vehicle/front.jpg",
          rear: "vehicle/rear.jpg",
          left: "vehicle/left.jpg",
          right: "vehicle/right.jpg",
        },
      ),
    ).toBe(true);
    expect(
      mobileV2VehiclePhotosMatchWrite(
        envelope.latestVehiclePhotos,
        write("dec-photos", { state: "submitted" }),
        ["front", "rear", "left", "right", "roof"],
        {
          front: "vehicle/front.jpg",
          rear: "vehicle/rear.jpg",
          left: "vehicle/left.jpg",
          right: "vehicle/right.jpg",
        },
      ),
    ).toBe(false);
    expect(
      mobileV2VehiclePhotosMatchWrite(
        envelope.latestVehiclePhotos,
        write("dec-other", { state: "submitted" }),
        ["front", "rear", "left", "right"],
      ),
    ).toBe(false);
    expect(
      mobileV2VehiclePhotosMatchWrite(
        envelope.latestVehiclePhotos,
        write("dec-photos", { state: "submitted" }),
        ["front", "rear", "left", "right"],
        {
          front: "vehicle/front-different.jpg",
          rear: "vehicle/rear.jpg",
          left: "vehicle/left.jpg",
          right: "vehicle/right.jpg",
        },
      ),
    ).toBe(false);
  });

  it("matches pre-shift writes only for the same cleared backend decision, shift, and health state", () => {
    const envelope = mapFieldopsOnboardingReadbackEnvelope({
      latest_pre_shift: {
        pass_id: "pass-1",
        shift_id: "shift-1",
        health_ok: true,
        state: "cleared",
        decision_log_id: "dec-pre",
      },
    });

    expect(mobileV2PreShiftMatchesWrite(envelope.latestPreShift, write("dec-pre", { state: "cleared" }), "shift-1", true)).toBe(true);
    expect(mobileV2PreShiftMatchesWrite(envelope.latestPreShift, write("dec-pre", { state: "cleared" }), "shift-2", true)).toBe(false);
    expect(mobileV2PreShiftMatchesWrite(envelope.latestPreShift, write("dec-pre", { state: "cleared" }), "shift-1", false)).toBe(false);
    expect(mobileV2PreShiftMatchesWrite(envelope.latestPreShift, write("dec-pre", { state: "blocked_health" }), "shift-1", true)).toBe(false);
    const blocked = mapFieldopsOnboardingReadbackEnvelope({
      latest_pre_shift: {
        pass_id: "pass-2",
        shift_id: "shift-1",
        health_ok: false,
        state: "blocked_health",
        decision_log_id: "dec-pre",
      },
    });
    expect(mobileV2PreShiftMatchesWrite(blocked.latestPreShift, write("dec-pre"), "shift-1", true)).toBe(false);
  });

  it("hydrates pre-shift health only from the same cleared backend shift", () => {
    const cleared = mapFieldopsOnboardingReadbackEnvelope({
      latest_pre_shift: {
        pass_id: "pass-1",
        shift_id: "shift-1",
        health_ok: true,
        state: "cleared",
        decision_log_id: "dec-pre",
      },
    });
    const blocked = mapFieldopsOnboardingReadbackEnvelope({
      latest_pre_shift: {
        pass_id: "pass-2",
        shift_id: "shift-1",
        health_ok: false,
        state: "blocked_health",
        decision_log_id: "dec-pre",
      },
    });

    expect(mobileV2PreShiftReadbackConfirmsHealthOk(cleared.latestPreShift, "shift-1")).toBe(true);
    expect(mobileV2PreShiftReadbackConfirmsHealthOk(cleared.latestPreShift, "shift-2")).toBe(false);
    expect(mobileV2PreShiftReadbackConfirmsHealthOk(blocked.latestPreShift, "shift-1")).toBe(false);
    expect(mobileV2PreShiftReadbackConfirmsHealthOk(null, "shift-1")).toBe(false);
  });
});
