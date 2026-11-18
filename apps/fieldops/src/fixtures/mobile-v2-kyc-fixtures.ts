// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type { MobileV2KycDocSpec } from "../mobile-v2-kyc-docs-screen";
import type {
  MobileV2IstimaraStatus,
} from "../mobile-v2-kyc-vehicle-screen";
import type {
  MobileV2VehicleAngle,
  MobileV2VehicleAngleId,
} from "../mobile-v2-kyc-vehicle-photos-screen";

// Aligned to design canvas s-kyc-docs artboard: post-upload approved
// state for all three required documents. The design ScrKycDocs snapshot
// shows green "Approved" chips, no per-card Scan/Upload buttons, and the
// enabled "Continue · vehicle registration" CTA at the bottom — i.e. the
// driver has finished step 1 of 4 and is ready to advance. Setting all
// docs to `approved` drives the same render path in the impl (see
// statusMeta + showCta gating in mobile-v2-kyc-docs-screen.tsx).
export const MOBILE_V2_PREVIEW_KYC_DOCS: ReadonlyArray<MobileV2KycDocSpec> =
  Object.freeze([
    Object.freeze({
      key: "idDoc",
      icon: "id" as const,
      title: "National ID / Iqama",
      sub: "Photo of front side",
      hint: "Hold steady · all corners visible · no glare",
      status: "approved" as const,
      required: true,
    }),
    Object.freeze({
      key: "licenseDoc",
      icon: "doc" as const,
      title: "Driving licence",
      sub: "Class C minimum · valid 6+ months",
      status: "approved" as const,
      required: true,
    }),
    Object.freeze({
      key: "iqamaDoc",
      icon: "doc" as const,
      title: "Iqama (work permit)",
      sub: "Front + back · valid expiry",
      status: "approved" as const,
      required: true,
    }),
  ]);

// Aligned to design canvas s-kyc-vehicle artboard: post-scan approved state
// with OCR-filled fields. Design SSOT `flow-onboard.jsx` ScrKycVehicle calls
// setIstimara('uploaded') then setPlate('RYD-4421') etc. after upload (lines
// 111-114); the canvas snapshot is taken at this filled state, showing the
// green "Approved" chip + "Captured · OCR filled fields below" body + active
// "Submit & continue · vehicle photos" CTA. Using `approved` here drives the
// same render path in the impl (statusTone="success" + statusLabel="Approved"
// per mobile-v2-kyc-vehicle-screen.tsx lines 74-89).
export const MOBILE_V2_PREVIEW_KYC_VEHICLE: {
  readonly istimaraStatus: MobileV2IstimaraStatus;
  readonly plate: string;
  readonly vin: string;
  readonly year: string;
  readonly model: string;
} = Object.freeze({
  istimaraStatus: "approved",
  plate: "RYD-4421",
  vin: "VF1•••••••42018",
  year: "2022",
  model: "Toyota Hiace · Cargo",
});

export const MOBILE_V2_PREVIEW_KYC_VEHICLE_ANGLES: ReadonlyArray<MobileV2VehicleAngle> =
  Object.freeze([
    Object.freeze({ id: "front" as const, label: "Front", hint: "Plate visible" }),
    Object.freeze({ id: "rear" as const, label: "Rear", hint: "Plate + tail lights" }),
    Object.freeze({ id: "left" as const, label: "Left side", hint: "Full length" }),
    Object.freeze({ id: "right" as const, label: "Right side", hint: "Full length" }),
  ]);

export const MOBILE_V2_PREVIEW_KYC_VEHICLE_PHOTOS: {
  readonly angles: ReadonlyArray<MobileV2VehicleAngle>;
  readonly capturedAngleIds: ReadonlyArray<MobileV2VehicleAngleId>;
} = Object.freeze({
  angles: MOBILE_V2_PREVIEW_KYC_VEHICLE_ANGLES,
  capturedAngleIds: Object.freeze([]),
});
