import { render, screen } from "@testing-library/react";
import { PickupRequestsPage } from "../../packages/ui/src/pickup-requests-page";
import { PickupWavesPage } from "../../packages/ui/src/pickup-waves-page";
import { createUiServerClient } from "@masarx/api/server";
import { loadPickupLookups } from "../../packages/ui/src/pickup-lookups";
import { loadPickupRequestRows, loadPickupWaveRows } from "../../packages/ui/src/pickup-page-shared";

jest.mock("@masarx/api/server", () => ({ createUiServerClient: jest.fn() }));
jest.mock("../../packages/ui/src/pickup-lookups", () => ({ loadPickupLookups: jest.fn() }));
jest.mock("../../packages/ui/src/pickup-page-shared", () => ({
  ...jest.requireActual("../../packages/ui/src/pickup-page-shared"),
  loadPickupRequestRows: jest.fn(), loadPickupWaveRows: jest.fn(),
}));
const me = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  (createUiServerClient as jest.Mock).mockReturnValue({ me });
  me.mockResolvedValue({ org: { id: "tenant" }, capabilities: ["shipments.write", "fleet.write"] });
  (loadPickupRequestRows as jest.Mock).mockResolvedValue({ rows: [], error: null });
  (loadPickupWaveRows as jest.Mock).mockResolvedValue({ rows: [], error: null });
  (loadPickupLookups as jest.Mock).mockResolvedValue({ error: null, options: {
    clients: [{ value: "client", label: "Fixture client" }], senders: [], branches: [],
    drivers: [{ value: "driver", label: "Fixture driver" }],
    vehicles: [{ value: "vehicle", label: "Truck 42" }], shipments: [],
  } });
});
const props = { appKey: "console" as const, appBasePath: "/console", searchParams: {}, testIdPrefix: "pickup" };

test("live request page supplies client/sender/branch relation fields", async () => {
  render(await PickupRequestsPage(props));
  expect(loadPickupLookups).toHaveBeenCalledWith(expect.objectContaining({ org: { id: "tenant" } }), "request");
  for (const name of ["Client", "Sender", "Branch"]) expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
  expect(screen.queryByLabelText("Client ID")).not.toBeInTheDocument();
});

test("live wave page uses shipment and assignment choices plus readable driver/vehicle labels", async () => {
  (loadPickupWaveRows as jest.Mock).mockResolvedValue({ error: null, rows: [{
    route_run_id: "route", organization_id: "tenant", driver_user_id: "driver", vehicle_id: "vehicle", status: "planned",
  }] });
  render(await PickupWavesPage(props));
  expect(loadPickupLookups).toHaveBeenCalledWith(expect.anything(), "wave");
  expect(screen.getByRole("combobox", { name: "Pickup shipments" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Driver" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Vehicle" })).toBeInTheDocument();
  expect(screen.getByText("Fixture driver")).toBeInTheDocument();
  expect(screen.getByText("Truck 42")).toBeInTheDocument();
});

test("read-only pages do not request write-only lookup data", async () => {
  me.mockResolvedValue({ org: { id: "tenant" }, capabilities: [] });
  render(await PickupRequestsPage(props));
  render(await PickupWavesPage(props));
  expect(loadPickupLookups).not.toHaveBeenCalled();
  expect(screen.queryAllByRole("combobox")).toHaveLength(0);
});
