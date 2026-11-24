jest.mock("@playwright/test", () => ({}), { virtual: true });
jest.mock("../e2e/utils/demo-accounts", () => ({}));
jest.mock("../e2e/utils/supabase", () => ({}));

const { assertShipmentProofFixture, buildShipmentPodAssetDownloadHref } = require("../e2e/utils/shipment-pod") as
  typeof import("../e2e/utils/shipment-pod");

const shipmentId = "10000000-0000-4000-8000-000000000000";
const artifactId = "10000000-0000-4000-8000-000000000001";
const fixture = {
  organizationId: "10000000-0000-4000-8000-000000000003",
  shipmentId,
  trackingNumber: "PODFIXEXAMPLE",
  consoleEmail: "operator@example.invalid",
  portalEmail: "reader@example.invalid",
  assets: [
    { id: artifactId, fileName: "fixture-proof-photo.jpg", mime: "image/jpeg", sha256: "b".repeat(64) },
    { id: "10000000-0000-4000-8000-000000000002", fileName: "fixture-recipient-signature.png", mime: "image/png", sha256: "c".repeat(64) },
  ],
};

test("binds the authorized download route to both shipment and artifact", () => {
  const link = new URL(buildShipmentPodAssetDownloadHref({ basePath: "", shipmentId, artifactId }), "https://portal.example.invalid");
  expect(link.pathname).toBe("/api/resource-download");
  expect(Object.fromEntries(link.searchParams)).toEqual({
    resource: "shipment_pod_asset", id: artifactId, shipment_id: shipmentId,
  });
});

test("requires a synthetic proof receipt with both unique assets and their hashes", () => {
  expect(() => assertShipmentProofFixture(fixture)).not.toThrow();
  expect(() => assertShipmentProofFixture({ ...fixture, organizationId: "" })).toThrow("synthetic receipt");
  expect(() => assertShipmentProofFixture({ ...fixture, trackingNumber: "OTHER" })).toThrow("synthetic receipt");
  expect(() => assertShipmentProofFixture({ ...fixture, assets: [fixture.assets[0], fixture.assets[0]] })).toThrow("synthetic receipt");
  expect(() => assertShipmentProofFixture({ ...fixture, assets: [fixture.assets[0], { ...fixture.assets[1], sha256: "" }] })).toThrow("synthetic receipt");
});
