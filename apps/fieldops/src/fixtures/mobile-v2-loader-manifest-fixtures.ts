// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.
//
// Mirrors the design source flow-loader.jsx LOADER_PARCELS seed:
// 9 parcels across 4 stops (STP-001..STP-004 + STP-008) with the
// exact ids/sku/size/weight/cold/scanned flags from the source.

import type { MobileV2LoaderManifestParcel } from "../mobile-v2-loader-manifest-screen";

export const MOBILE_V2_PREVIEW_LOADER_MANIFEST: ReadonlyArray<MobileV2LoaderManifestParcel> =
  Object.freeze([
    Object.freeze({ id: "P-22841", sku: "SKU-9921", destStopId: "STP-001", size: "S", weightKg: 1.2, cold: false, scanned: true }),
    Object.freeze({ id: "P-22842", sku: "SKU-7711", destStopId: "STP-002", size: "M", weightKg: 2.1, cold: false, scanned: true }),
    Object.freeze({ id: "P-22843", sku: "SKU-7711", destStopId: "STP-002", size: "M", weightKg: 2.0, cold: false, scanned: true }),
    Object.freeze({ id: "P-22844", sku: "SKU-3308", destStopId: "STP-002", size: "L", weightKg: 0.7, cold: false, scanned: true }),
    Object.freeze({ id: "P-22845", sku: "SKU-9921", destStopId: "STP-003", size: "S", weightKg: 1.0, cold: false, scanned: true }),
    Object.freeze({ id: "P-22846", sku: "SKU-9921", destStopId: "STP-003", size: "S", weightKg: 1.1, cold: false, scanned: false }),
    Object.freeze({ id: "P-22847", sku: "SKU-RX12", destStopId: "STP-004", size: "XS", weightKg: 0.4, cold: true, scanned: false }),
    Object.freeze({ id: "P-22848", sku: "SKU-RX12", destStopId: "STP-008", size: "M", weightKg: 1.4, cold: true, scanned: false }),
    Object.freeze({ id: "P-22849", sku: "SKU-RX12", destStopId: "STP-008", size: "M", weightKg: 1.6, cold: true, scanned: false }),
  ]);
