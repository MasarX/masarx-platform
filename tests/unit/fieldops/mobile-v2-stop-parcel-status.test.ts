import {
  countMobileV2ResolvedScannedParcels,
  mobileV2StopProofIsDone,
  resolveMobileV2StopParcelStatus,
} from "../../../apps/fieldops/src/mobile-v2-stop-parcel-status";

describe("Mobile V2 stop parcel status readback", () => {
  const scanDone = Object.freeze([{ key: "scan", label: "Scan all parcels", status: "done" as const }]);

  test("uses backend scan proof to reconcile all-pending parcel rows after POD readback", () => {
    const parcels = Object.freeze([
      { id: "parcel-1", code: "2600558HQ:1", status: "pending" as const },
      { id: "parcel-2", code: "2600558HQ:2", status: "pending" as const },
    ]);
    expect(
      resolveMobileV2StopParcelStatus(
        parcels[0],
        scanDone,
        parcels,
      ),
    ).toBe("scanned");
  });

  test("keeps backend partial POD parcel subset visible when scan proof is done", () => {
    const parcels = Object.freeze([
      { id: "parcel-1", code: "2600558HQ:1", status: "scanned" as const },
      { id: "parcel-2", code: "2600558HQ:2", status: "pending" as const },
      { id: "parcel-3", code: "2600558HQ:3", status: "pending" as const },
    ]);

    expect(resolveMobileV2StopParcelStatus(parcels[0], scanDone, parcels)).toBe("scanned");
    expect(resolveMobileV2StopParcelStatus(parcels[1], scanDone, parcels)).toBe("pending");
    expect(resolveMobileV2StopParcelStatus(parcels[2], scanDone, parcels)).toBe("pending");
    expect(countMobileV2ResolvedScannedParcels(parcels, scanDone)).toBe(1);
  });

  test("does not hide explicit parcel exceptions", () => {
    expect(
      resolveMobileV2StopParcelStatus(
        { id: "parcel-1", code: "2600558HQ:1", status: "missing" },
        scanDone,
      ),
    ).toBe("missing");
  });

  test("keeps pending state when backend scan proof is not done", () => {
    expect(
      resolveMobileV2StopParcelStatus(
        { id: "parcel-1", code: "2600558HQ:1", status: "pending" },
        [{ key: "scan", label: "Scan all parcels", status: "pending" }],
      ),
    ).toBe("pending");
  });

  test("counts resolved scanned parcels from backend proof state", () => {
    expect(
      countMobileV2ResolvedScannedParcels(
        [
          { id: "parcel-1", code: "2600558HQ:1", status: "pending" },
          { id: "parcel-2", code: "2600558HQ:2", status: "damaged" },
        ],
        scanDone,
      ),
    ).toBe(1);
  });

  test("exposes proof lookup for stop screen display decisions", () => {
    expect(mobileV2StopProofIsDone(scanDone, "scan")).toBe(true);
    expect(mobileV2StopProofIsDone(scanDone, "cod")).toBe(false);
  });
});
