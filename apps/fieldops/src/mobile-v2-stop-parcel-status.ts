import type {
  MobileV2StopParcel,
  MobileV2StopProofCheckpoint,
} from "./mobile-v2-stop-screen";

export function mobileV2StopProofIsDone(
  proofChecklist: ReadonlyArray<MobileV2StopProofCheckpoint>,
  key: string,
): boolean {
  return proofChecklist.some((checkpoint) => checkpoint.key === key && checkpoint.status === "done");
}

export function resolveMobileV2StopParcelStatus(
  parcel: MobileV2StopParcel,
  proofChecklist: ReadonlyArray<MobileV2StopProofCheckpoint>,
  allParcels: ReadonlyArray<MobileV2StopParcel> = Object.freeze([parcel]),
): MobileV2StopParcel["status"] {
  const hasBackendScannedSubset = allParcels.some((entry) => entry.status === "scanned");
  if (
    parcel.status === "pending" &&
    !hasBackendScannedSubset &&
    mobileV2StopProofIsDone(proofChecklist, "scan")
  ) {
    return "scanned";
  }
  return parcel.status;
}

export function countMobileV2ResolvedScannedParcels(
  parcels: ReadonlyArray<MobileV2StopParcel>,
  proofChecklist: ReadonlyArray<MobileV2StopProofCheckpoint>,
): number {
  return parcels.filter((parcel) => resolveMobileV2StopParcelStatus(parcel, proofChecklist, parcels) === "scanned").length;
}
