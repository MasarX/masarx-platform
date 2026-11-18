import {
  buildMobileV2PodCloseoutEvidence,
  buildMobileV2PodFailureEvidence,
  extractMobileV2BoxNumberFromBarcode,
  normalizeMobileV2DeliveredBoxNumbers,
} from "../../../apps/fieldops/src/mobile-v2-pod-closeout-evidence";
import {
  buildMobileV2CleaningEvidenceStorageKey,
  buildMobileV2IstimaraStorageKey,
  buildMobileV2KycDocumentStorageKey,
  buildMobileV2PodArtifactStorageKey,
  buildMobileV2VehiclePhotoStorageKey,
  buildMobileV2SignatureArtifactCaptureInput,
  formatMobileV2PodArtifactMethodList,
  getMobileV2RequiredPodArtifactKind,
  listMissingMobileV2PodArtifactMethods,
  MOBILE_V2_SIGNATURE_FILE_EXTENSION,
  MOBILE_V2_SIGNATURE_MIME_TYPE,
  normalizeMobileV2PodArtifactIds,
} from "../../../apps/fieldops/src/mobile-v2-pod-artifacts";

describe("buildMobileV2PodCloseoutEvidence", () => {
  test("keeps non-COD POD evidence minimal", () => {
    expect(
      buildMobileV2PodCloseoutEvidence({
        methods: ["scan", "photo", "sig"],
        capturedAt: "2026-05-26T10:00:00.000Z",
      }),
    ).toEqual({
      pod_methods: "scan+photo+sig",
      captured_at: "2026-05-26T10:00:00.000Z",
    });
  });

  test("adds canonical COD collection fields for route stop closeout", () => {
    expect(
      buildMobileV2PodCloseoutEvidence({
        methods: ["scan", "photo", "sig", "cod"],
        capturedAt: "2026-05-26T10:00:00.000Z",
        artifactIds: ["4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"],
        scanCodes: ["MV2CLOSE8bProof2:1"],
        otpCode: "4821",
        cod: {
          amount: 42.5,
          currency: "sar",
          tenderedAmount: 50,
        },
      }),
    ).toEqual({
      pod_methods: "scan+photo+sig+cod",
      captured_at: "2026-05-26T10:00:00.000Z",
      artifact_ids: ["4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"],
      pod: {
        artifact_ids: ["4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"],
        delivered_box_numbers: [1],
      },
      scan_codes: ["MV2CLOSE8bProof2:1"],
      scan: {
        codes: ["MV2CLOSE8bProof2:1"],
        count: 1,
      },
      delivered_box_numbers: [1],
      delivery_completion: {
        delivered_box_numbers: [1],
      },
      otp_code: "4821",
      otp: {
        entered: true,
        code_length: 4,
      },
      payment_outcome: "collected",
      payment_method: "cash",
      payment_amount: 42.5,
      payment_receipt_context: "fieldops_mobile_v2_pod",
      payment_collection: {
        outcome: "collected",
        method: "cash",
        expected_amount: 42.5,
        collected_amount: 42.5,
        tendered_amount: 50,
        change_due_amount: 7.5,
        currency: "SAR",
        receipt_context: "fieldops_mobile_v2_pod",
      },
    });
  });

  test("carries partial POD delivered-box lineage for route-stop closeout", () => {
    expect(
      buildMobileV2PodCloseoutEvidence({
        methods: ["scan", "photo", "sig"],
        capturedAt: "2026-05-28T10:00:00.000Z",
        artifactIds: [
          "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
          "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
          " ",
        ],
        scanCodes: ["MV2PARTIAL-PROOF:2", "MV2PARTIAL-PROOF:1", "bad-code"],
        deliveredBoxIds: [
          "22222222-2222-4222-8222-222222222222",
          "33333333-3333-4333-8333-333333333333",
          "22222222-2222-4222-8222-222222222222",
          " ",
        ],
        deliveredBoxNumbers: [3, 2, 3, 0, -1, 1.5],
      }),
    ).toEqual({
      pod_methods: "scan+photo+sig",
      captured_at: "2026-05-28T10:00:00.000Z",
      artifact_ids: ["4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"],
      pod: {
        artifact_ids: ["4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"],
        delivered_box_ids: [
          "22222222-2222-4222-8222-222222222222",
          "33333333-3333-4333-8333-333333333333",
        ],
        delivered_box_numbers: [1, 2, 3],
      },
      scan_codes: ["MV2PARTIAL-PROOF:2", "MV2PARTIAL-PROOF:1", "bad-code"],
      scan: {
        codes: ["MV2PARTIAL-PROOF:2", "MV2PARTIAL-PROOF:1", "bad-code"],
        count: 3,
      },
      delivered_box_ids: [
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
      ],
      delivered_box_numbers: [1, 2, 3],
      delivery_completion: {
        delivered_box_ids: [
          "22222222-2222-4222-8222-222222222222",
          "33333333-3333-4333-8333-333333333333",
        ],
        delivered_box_numbers: [1, 2, 3],
      },
    });
  });

  test("normalizes delivered box numbers from explicit input and parcel barcode suffixes", () => {
    expect(extractMobileV2BoxNumberFromBarcode("MV2BOX:12")).toBe(12);
    expect(extractMobileV2BoxNumberFromBarcode("MV2BOX:0")).toBeNull();
    expect(extractMobileV2BoxNumberFromBarcode("MV2BOX:not-a-number")).toBeNull();
    expect(
      normalizeMobileV2DeliveredBoxNumbers(
        [3, 1, 3, 0, -2, 2.5],
        ["TRACK:2", "TRACK:10", "TRACK:bad", "TRACK:1"],
      ),
    ).toEqual([1, 2, 3, 10]);
  });

  test("normalizes registered artifact ids for POD closeout evidence", () => {
    expect(
      normalizeMobileV2PodArtifactIds([
        "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
        {
          artifactId: "22222222-2222-4222-8222-222222222222",
          kind: "signature",
          method: "sig",
          capturedAt: "2026-05-26T10:00:00.000Z",
        },
        "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
        " ",
      ]),
    ).toEqual([
      "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  test("builds tenant-scoped POD artifact storage keys", () => {
    expect(
      buildMobileV2PodArtifactStorageKey({
        organizationId: "08d59e17-82ae-47c4-b54a-4a6b86213dc4",
        routeStopId: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
        kind: "signature",
        extension: ".png",
        uniqueId: "Capture 1",
      }),
    ).toBe(
      "08d59e17-82ae-47c4-b54a-4a6b86213dc4/pod/4d1fbd36-6b6e-4c35-acc4-5e3ad9043830/signature-capture-1.png",
    );
  });

  test("builds tenant-scoped onboarding artifact storage keys", () => {
    const organizationId = "08d59e17-82ae-47c4-b54a-4a6b86213dc4";

    expect(
      buildMobileV2KycDocumentStorageKey({
        organizationId,
        docKey: "National ID",
        uniqueId: "Capture 1",
      }),
    ).toBe(`${organizationId}/kyc-documents/national-id/photo-capture-1.jpg`);
    expect(
      buildMobileV2IstimaraStorageKey({
        organizationId,
        uniqueId: "Capture 2",
      }),
    ).toBe(`${organizationId}/kyc-vehicle/istimara/photo-capture-2.jpg`);
    expect(
      buildMobileV2VehiclePhotoStorageKey({
        organizationId,
        angleId: "Front Angle",
        uniqueId: "Capture 3",
      }),
    ).toBe(`${organizationId}/vehicle-photos/front-angle/photo-capture-3.jpg`);
    expect(
      buildMobileV2CleaningEvidenceStorageKey({
        organizationId,
        shiftId: "Route Run 1",
        uniqueId: "Capture 4",
      }),
    ).toBe(`${organizationId}/cleaning/route-run-1/photo-capture-4.jpg`);
  });

  test("builds captured signatures as scoped PNG evidence", () => {
    const capturedAt = "2026-05-26T10:00:00.000Z";
    const input = buildMobileV2SignatureArtifactCaptureInput({
      width: 320,
      height: 180,
      capturedAt,
      strokes: [[
        { x: 24, y: 80 },
        { x: 120, y: 92 },
        { x: 260, y: 60 },
      ]],
    });

    expect(input).toMatchObject({
      kind: "signature",
      method: "sig",
      mimeType: MOBILE_V2_SIGNATURE_MIME_TYPE,
      extension: MOBILE_V2_SIGNATURE_FILE_EXTENSION,
      capturedAt,
      metadata: {
        proof_type: "sig",
        artifact_kind: "signature",
        signature: {
          strokes: 1,
          width: 320,
          height: 180,
        },
      },
    });
    expect(input.text).toBeUndefined();
    const bytes = Buffer.from(input.base64 ?? "", "base64");
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
    expect(bytes.toString("ascii", bytes.length - 8, bytes.length - 4)).toBe("IEND");
  });

  test("identifies required registered artifacts before POD step advancement", () => {
    expect(getMobileV2RequiredPodArtifactKind("photo")).toBe("photo");
    expect(getMobileV2RequiredPodArtifactKind("sig")).toBe("signature");
    expect(getMobileV2RequiredPodArtifactKind("id")).toBe("identity");
    expect(getMobileV2RequiredPodArtifactKind("scan")).toBeNull();

    expect(
      listMissingMobileV2PodArtifactMethods(["scan", "photo", "sig", "cod"], [
        {
          artifactId: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
          kind: "photo",
          method: "photo",
          capturedAt: "2026-05-26T10:00:00.000Z",
        },
      ]),
    ).toEqual(["sig"]);

    expect(formatMobileV2PodArtifactMethodList(["photo", "sig", "id"])).toBe(
      "parcel photo, customer signature, ID document",
    );
  });
});

describe("buildMobileV2PodFailureEvidence", () => {
  test("carries policy-required note and gate readback into failed-delivery evidence", () => {
    expect(
      buildMobileV2PodFailureEvidence({
        capturedAt: "2026-05-27T10:00:00.000Z",
        reason: {
          code: "recipient_unavailable",
          label: "Recipient unavailable",
          reattempt: true,
          photo: false,
          note: true,
          escalate: false,
          codOnly: false,
        },
        context: {
          note: "Customer did not answer after two calls",
          photoCaptured: false,
          escalateAcknowledged: false,
        },
      }),
    ).toEqual({
      reason_code: "recipient_unavailable",
      reason_label: "Recipient unavailable",
      exception_reason: "recipient_unavailable",
      reattempt: true,
      escalate: false,
      captured_at: "2026-05-27T10:00:00.000Z",
      exception_notes: "Customer did not answer after two calls",
      exception_evidence: {
        proof_artifact_count: 0,
        artifact_ids: [],
      },
      failure_note: "Customer did not answer after two calls",
      failure_required: {
        photo: false,
        note: true,
        escalate_acknowledgement: false,
      },
      failure_captured: {
        photo: false,
        note: true,
        escalate_acknowledgement: false,
      },
      failed_delivery: {
        reason_code: "recipient_unavailable",
        reason_label: "Recipient unavailable",
        reattempt: true,
        escalate: false,
        cod_only: false,
        required: {
          photo: false,
          note: true,
          escalate_acknowledgement: false,
        },
        captured: {
          photo: false,
          note: true,
          escalate_acknowledgement: false,
        },
        note: "Customer did not answer after two calls",
      },
    });
  });

  test("does not fabricate a note when the operator did not provide one", () => {
    expect(
      buildMobileV2PodFailureEvidence({
        capturedAt: "2026-05-27T10:00:00.000Z",
        reason: {
          code: "parcel_damaged",
          label: "Parcel damaged",
          reattempt: false,
          photo: true,
          note: true,
          escalate: true,
          codOnly: false,
        },
        context: {
          note: "  ",
          photoCaptured: true,
          escalateAcknowledged: true,
          artifactIds: ["33333333-3333-4333-8333-333333333333"],
        },
      }),
    ).toEqual({
      reason_code: "parcel_damaged",
      reason_label: "Parcel damaged",
      exception_reason: "parcel_damaged",
      reattempt: false,
      escalate: true,
      captured_at: "2026-05-27T10:00:00.000Z",
      exception_notes: null,
      exception_evidence: {
        proof_artifact_count: 1,
        artifact_ids: ["33333333-3333-4333-8333-333333333333"],
      },
      failure_note: null,
      failure_artifact_ids: ["33333333-3333-4333-8333-333333333333"],
      failure_required: {
        photo: true,
        note: true,
        escalate_acknowledgement: true,
      },
      failure_captured: {
        photo: true,
        note: false,
        escalate_acknowledgement: true,
      },
      failed_delivery: {
        reason_code: "parcel_damaged",
        reason_label: "Parcel damaged",
        reattempt: false,
        escalate: true,
        cod_only: false,
        required: {
          photo: true,
          note: true,
          escalate_acknowledgement: true,
        },
        captured: {
          photo: true,
          note: false,
          escalate_acknowledgement: true,
        },
        artifact_ids: ["33333333-3333-4333-8333-333333333333"],
      },
    });
  });

  test("access_restricted carries Mobile V2 nested note evidence for backend attempt guard", () => {
    expect(
      buildMobileV2PodFailureEvidence({
        capturedAt: "2026-05-27T11:00:00.000Z",
        reason: {
          code: "access_restricted",
          label: "Access restricted",
          reattempt: true,
          photo: false,
          note: true,
          escalate: false,
          codOnly: false,
        },
        context: {
          note: "Security gate denied access and logged driver badge.",
          photoCaptured: false,
          escalateAcknowledged: false,
        },
      }),
    ).toMatchObject({
      reason_code: "access_restricted",
      exception_reason: "access_restricted",
      exception_notes: "Security gate denied access and logged driver badge.",
      exception_evidence: {
        proof_artifact_count: 0,
        artifact_ids: [],
      },
      failed_delivery: {
        reason_code: "access_restricted",
        note: "Security gate denied access and logged driver badge.",
        required: {
          photo: false,
          note: true,
          escalate_acknowledgement: false,
        },
        captured: {
          photo: false,
          note: true,
          escalate_acknowledgement: false,
        },
      },
    });
  });
});
