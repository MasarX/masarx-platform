// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type {
  MobileV2ProfileAppStatus,
  MobileV2ProfileDocument,
  MobileV2ProfileIdentity,
  MobileV2ProfileRole,
  MobileV2ProfileStats,
} from "../mobile-v2-profile-screen";

// Aligned to design canvas s-profile artboard: Omar Al-Saadi identity
// (matches greetingName used by rider-today fixture), short Olaya
// address copy, KSA-style DOB, and "Layla Al-Saadi" emergency contact.
const IDENTITY: MobileV2ProfileIdentity = Object.freeze({
  employeeId: "DRV-2041",
  name: "Omar Al-Saadi",
  username: "omar.alsaadi",
  phone: "+447 70 090 0119",
  email: "profile@example.com",
  address: "Al Olaya · Riyadh, KSA",
  dob: "1990-04-12",
  vehicle: "RUH 4892",
  emergencyContactName: "Layla Al-Saadi",
  emergencyContactPhone: "+447 70 090 0120",
  emergencyContactRelation: "Spouse",
  bankIban: "SA03 4000 0000 0000 0481 0481",
  bankName: "Al Rajhi Bank",
});

// Aligned to design canvas s-profile artboard today-stats strip:
// 2 delivered / 1 failed / 0 COD / 96% on-time (start-of-shift snapshot
// matching the rider-today screen Hello-Omar context).
const STATS: MobileV2ProfileStats = Object.freeze({
  deliveredToday: 2,
  failedToday: 1,
  codToday: 0,
  onTimeRate: 96,
  rating: 4.8,
  streakDays: 12,
});

const DOCUMENTS: ReadonlyArray<MobileV2ProfileDocument> = Object.freeze([
  Object.freeze({
    id: "idDoc",
    icon: "id" as const,
    label: "National ID / Iqama",
    sub: "Front · OCR fills name + ID",
    status: "approved" as const,
    expiryIso: "2027-08-12",
  }),
  Object.freeze({
    id: "licenseDoc",
    icon: "doc" as const,
    label: "Driving licence",
    sub: "Class C · valid 6+ months",
    status: "approved" as const,
    expiryIso: "2026-11-30",
  }),
  Object.freeze({
    id: "iqamaDoc",
    icon: "doc" as const,
    label: "Iqama (work permit)",
    sub: "Front + back",
    status: "uploaded" as const,
    expiryIso: "2026-09-04",
  }),
  Object.freeze({
    id: "vehicleReg",
    icon: "truck" as const,
    label: "Vehicle registration",
    sub: "Istimara · MoT-verified",
    status: "approved" as const,
    expiryIso: "2026-07-22",
  }),
  Object.freeze({
    id: "vehiclePhotos",
    icon: "camera" as const,
    label: "Vehicle photos (4 angles)",
    sub: "Refresh weekly · last shoot 3d ago",
    status: "pending" as const,
    expiryIso: null,
  }),
]);

const APP_STATUS: MobileV2ProfileAppStatus = Object.freeze({
  languageLabel: "English",
  languageSub: "Left-to-right",
  securityLabel: "PIN · biometric",
  securitySub: "Last sign-in 09:32 · this device",
  notificationLabel: "6/8 channels on",
  appearanceLabel: "Field hi-vis",
  permissionsLabel: "4/5 granted",
});

export const MOBILE_V2_PREVIEW_PROFILE: {
  readonly role: MobileV2ProfileRole;
  readonly identity: MobileV2ProfileIdentity;
  readonly stats: MobileV2ProfileStats;
  readonly documents: ReadonlyArray<MobileV2ProfileDocument>;
  readonly appStatus: MobileV2ProfileAppStatus;
  readonly accountId: string;
  readonly appVersion: string;
  readonly currency: string;
} = Object.freeze({
  role: "driver" as const,
  identity: IDENTITY,
  stats: STATS,
  documents: DOCUMENTS,
  appStatus: APP_STATUS,
  accountId: "AC-MASARX-002",
  appVersion: "v3.4.1 · build 2026.05",
  // ISO currency code — the profile screen resolves the display symbol
  // (SAR → ﷼) via `formatMobileV2CurrencyCompact`, matching the design
  // `ScrProfile` stat label "COD ﷼". Production cutover keeps the symbol
  // row-driven via `mobile_wallet_locale_policy`.
  currency: "SAR",
});
