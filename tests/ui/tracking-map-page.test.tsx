import { screen } from "@testing-library/react";
import { createUiServerClient } from "@masarx/api/server";
import { TrackingMapPage } from "../../packages/ui/src/tracking-map-page";
import { loadTrackingDataset } from "../../packages/ui/src/tracking-map-composer";
import { resolveTrackingMapConfiguration } from "../../packages/ui/src/tracking-map-policy";
import type { TrackingMapConfiguration } from "../../packages/ui/src/tracking-map-policy";
import { TrackingMap } from "../../packages/ui/src/tracking-map";
import { renderWithIntl } from "./test-utils";
jest.mock("@masarx/api/server", () => ({ createUiServerClient: jest.fn() }));
jest.mock("../../packages/ui/src/tracking-map-composer", () => ({ loadTrackingDataset: jest.fn() }));
jest.mock("../../packages/ui/src/tracking-map-policy", () => ({ resolveTrackingMapConfiguration: jest.fn() }));
jest.mock("../../packages/ui/src/tracking-map", () => ({ TrackingMap: jest.fn(() => <div data-testid="real-map-seam" />) }));
const load = loadTrackingDataset as jest.Mock;
const policy = resolveTrackingMapConfiguration as jest.Mock;
const props = {
  searchParams: {},
  locale: "en",
  baseHref: "/console/operations/tracking-map",
  testIdPrefix: "console-tracking-map",
};
beforeEach(() => {
  jest.resetAllMocks();
  (TrackingMap as jest.Mock).mockImplementation(() => <div data-testid="real-map-seam" />);
  (createUiServerClient as jest.Mock).mockReturnValue({ me: jest.fn().mockResolvedValue({ access_scope: { scope_type: "tenant", scope_id: "t" } }), mapPolicy: jest.fn().mockResolvedValue({ value: {} }) });
});
it("renders all six fallback columns and escaped text without map policy", async () => {
  load.mockResolvedValue({ resource: "tracking_shipments", pins: [], locations: [{ id: "s", trackingNumber: "<script>x</script>", status: "in_transit", originCity: "A", destinationCity: null, serviceType: "parcel", updatedAt: "2026-09-11" }], offset: 0, limit: 2, hasNext: true });
  const view = renderWithIntl(await TrackingMapPage(props));
  expect(screen.getByTestId("console-tracking-map-ready")).toBeInTheDocument();
  expect(screen.getAllByRole("columnheader")).toHaveLength(6);
  expect(screen.getByRole("table")).toHaveAccessibleName("Shipment locations — 1 locations on this page");
  expect(screen.getByText("<script>x</script>")).toBeInTheDocument();
  expect(view.container.querySelector("script")).toBeNull();
  expect(policy).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute("href", "/console/operations/tracking-map?offset=2&limit=2");
});
it.each(["en", "ar"])("renders positive destination and last-update date using page locale %s", async locale => {
  const updatedAt = "2026-09-11T12:00:00Z";
  load.mockResolvedValue({ resource: "tracking_shipments", pins: [], locations: [{
    id: "s", trackingNumber: "TRACK-1", status: "in_transit", originCity: "Origin",
    destinationCity: "Destination", serviceType: "parcel", updatedAt,
  }], offset: 0, limit: 2, hasNext: false });
  renderWithIntl(await TrackingMapPage({ ...props, locale }), { locale });
  expect(screen.getAllByRole("cell").map(cell => cell.textContent)).toEqual([
    "TRACK-1", "in transit", "Origin", "Destination", "parcel",
    new Intl.DateTimeFormat(locale).format(new Date(updatedAt)),
  ]);
});
it("surfaces loader errors instead of displaying empty fallback", async () => {
  load.mockRejectedValue(new Error("private database details"));
  renderWithIntl(await TrackingMapPage(props));
  expect(screen.getByTestId("console-tracking-map-error")).toBeInTheDocument();
  expect(screen.queryByText("private database details")).toBeNull();
});
it("blocks absent policy and invokes the renderer for approved configuration", async () => {
  load.mockResolvedValue({ identity: "x", resource: "tracking_geocode_pins", pins: [{ id: "p", latitude: 1, longitude: 2, label: null, status: null }], locations: [], offset: 0, limit: 2, hasNext: false });
  policy.mockReturnValue({ ok: false, reason: "unconfigured" });
  const view = renderWithIntl(await TrackingMapPage(props));
  expect(screen.getByTestId("tracking-map-policy-blocked")).toBeInTheDocument();
  expect((createUiServerClient as jest.Mock).mock.results[0].value.mapPolicy).toHaveBeenCalledWith({ organization_id: "t" });
  expect(screen.queryByTestId("real-map-seam")).toBeNull();
  view.unmount();
  const configuration: Extract<TrackingMapConfiguration, { ok: true }> = { ok: true, style: { version: 8, sources: {}, layers: [] }, camera: { singlePointZoom: 8, maxZoom: 8, padding: { top: 20, bottom: 20, left: 20, right: 20 } }, attributionLabel: "Approved", attributionUrl: "https://approved.example/", loadTimeoutMs: 2000 };
  policy.mockReturnValue(configuration);
  renderWithIntl(await TrackingMapPage(props));
  expect(screen.getByTestId("real-map-seam")).toBeInTheDocument();
  expect((TrackingMap as jest.Mock).mock.calls[0][0]).toMatchObject({ identity: "x", pins: [{ id: "p", latitude: 1, longitude: 2, label: null, status: null }], policy: configuration, labels: { map: "Geographic map", loading: "Loading map", unavailable: "Tracking is unavailable. Check access and map configuration.", empty: "No tracking locations are available." } });
});
