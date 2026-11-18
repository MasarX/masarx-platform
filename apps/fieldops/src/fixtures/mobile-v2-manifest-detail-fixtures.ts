// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Mirrors design source flow-network-extras.jsx ScrManifest stub: 8
// parcels per waybill, 6 scanned at gate-out and 2 not yet scanned.
// Origin merchant + city/waybill match the design source.

import type { MobileV2ManifestLine } from "../mobile-v2-manifest-detail-screen";

export const MOBILE_V2_PREVIEW_MANIFEST_DETAIL_LINES: ReadonlyArray<MobileV2ManifestLine> =
  Object.freeze([
    Object.freeze({ id: "PCL-440100", status: "scanned" as const }),
    Object.freeze({ id: "PCL-440101", status: "scanned" as const }),
    Object.freeze({ id: "PCL-440102", status: "scanned" as const }),
    Object.freeze({ id: "PCL-440103", status: "scanned" as const }),
    Object.freeze({ id: "PCL-440104", status: "scanned" as const }),
    Object.freeze({ id: "PCL-440105", status: "scanned" as const }),
    // Both bottom rows kept in initial "pending" state to match the design
    // canvas ScrManifestDetail artboard (both rows show "Not yet scanned" +
    // "Mark missing" CTA). Prior fixture seeded one missing + one extra,
    // which exercised more code paths but diverged from the design canvas
    // baseline used by the pixel-diff harness.
    Object.freeze({ id: "PCL-440106", status: "pending" as const }),
    Object.freeze({ id: "PCL-440107", status: "pending" as const }),
  ]);

export const MOBILE_V2_PREVIEW_MANIFEST_DETAIL = Object.freeze({
  manifestId: "WB-RYD-7740",
  originMerchant: "Layla Boutique",
  originCity: "Riyadh",
  waybillId: "WB-RYD-7740",
  lines: MOBILE_V2_PREVIEW_MANIFEST_DETAIL_LINES,
});
