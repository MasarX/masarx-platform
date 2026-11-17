jest.mock("@masarx/api", () => ({ ...jest.requireActual("@masarx/api"), createUiClient: jest.fn() }));
import { createUiClient } from "@masarx/api";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VehicleCreateForm, VehicleCreateTargetForm } from "../../packages/ui/src/vehicle-create-form";

const client = createUiClient as unknown as jest.Mock;
const labels = { submit: "Create vehicle", submitting: "Creating", succeeded: "Created", failed: "Failed safely", denied: "Denied" };
const schema = { type: "object", properties: {
  plate_number: { type: "string", title: "Plate number", minLength: 1 },
  vehicle_type_id: { type: "string", title: "Vehicle type", "x-ui": { widget: "resource_select", resource: "vehicle_create_type_directory", filters: { is_active: true } } },
  branch_id: { type: "string", title: "Branch", "x-ui": { widget: "resource_select", resource: "vehicle_create_branch_directory" } },
}, required: ["plate_number"] };
const props = { actorId: "actor-a", organizationId: "org-a", schema, canCreate: true, labels,
  submitAction: (organizationId: string, value: unknown) => client().createVehicle({ ...(value as Record<string, unknown>), organization_id: organizationId }) };

describe("VehicleCreateForm", () => {
  beforeEach(() => jest.resetAllMocks());
  it("binds both existing resource selectors to the selected organization", async () => {
    const listResource = jest.fn().mockResolvedValue({ items: [] });
    client.mockReturnValue({ listResource });
    render(<VehicleCreateForm {...props} />);
    await waitFor(() => expect(listResource).toHaveBeenCalledTimes(2));
    expect(listResource).toHaveBeenCalledWith("vehicle_create_type_directory", { is_active: true, organization_id: "org-a" }, 100, 0, { key: "name", direction: "asc" });
    expect(listResource).toHaveBeenCalledWith("vehicle_create_branch_directory", { organization_id: "org-a" }, 100, 0, { key: "name", direction: "asc" });
  });
  it("submits the canonical create inputs once and does not expose errors", async () => {
    let reject!: (error: Error) => void;
    const createVehicle = jest.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
    client.mockReturnValue({ listResource: jest.fn().mockResolvedValue({ items: [] }), createVehicle });
    render(<VehicleCreateForm {...props} />);
    fireEvent.change(screen.getByRole("textbox", { name: /Plate number/ }), { target: { value: "QA-123" } });
    fireEvent.submit(screen.getByTestId("vehicle-create-form"));
    fireEvent.submit(screen.getByTestId("vehicle-create-form"));
    expect(createVehicle).toHaveBeenCalledTimes(1);
    expect(createVehicle).toHaveBeenCalledWith({ plate_number: "QA-123", organization_id: "org-a" });
    await act(async () => reject(new Error("private-error-sentinel")));
    expect(screen.getByRole("alert")).toHaveTextContent("Failed safely");
    expect(screen.queryByText(/private-error-sentinel/)).not.toBeInTheDocument();
  });
  it("discards old actor/tenant selector responses and resets entered values", async () => {
    let resolveOld!: (value: unknown) => void;
    const old = new Promise(resolve => { resolveOld = resolve; });
    const listResource = jest.fn((_resource, filters) => filters.organization_id === "org-a" ? old : Promise.resolve({ items: [{ id: "new", name: "New tenant option" }] }));
    client.mockReturnValue({ listResource });
    const view = render(<VehicleCreateForm {...props} />);
    fireEvent.change(screen.getByRole("textbox", { name: /Plate number/ }), { target: { value: "old plate" } });
    view.rerender(<VehicleCreateForm {...props} actorId="actor-b" organizationId="org-b" />);
    await act(async () => resolveOld({ items: [{ id: "old", name: "Old tenant option" }] }));
    expect(screen.getByRole("textbox", { name: /Plate number/ })).toHaveValue("");
    fireEvent.click(screen.getAllByRole("combobox")[0]);
    await waitFor(() => expect(screen.getByRole("option")).toHaveTextContent("New tenant option"));
    expect(screen.queryByText("Old tenant option")).not.toBeInTheDocument();
  });
  it("does not fetch or submit without admitted creation capability", () => {
    render(<VehicleCreateForm {...props} canCreate={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Denied");
    expect(client).not.toHaveBeenCalled();
  });
  it("exposes schema required and minimum length on the accessible scalar input", async () => {
    const createVehicle = jest.fn();
    client.mockReturnValue({ listResource: jest.fn().mockResolvedValue({ items: [] }), createVehicle });
    const strictSchema = { ...schema, properties: { ...schema.properties, plate_number: { type: "string", title: "Plate number", minLength: 4 } } };
    await act(async () => {
      render(<VehicleCreateForm {...props} schema={strictSchema} />);
    });
    const plate = screen.getByRole("textbox", { name: /Plate number/ });
    expect(plate).toBeRequired();
    expect(plate).toHaveAttribute("minlength", "4");
    expect(createVehicle).not.toHaveBeenCalled();
  });
  it("uses the existing authorized organization directory before loading target options", async () => {
    const listResource = jest.fn((resource) => Promise.resolve({ items: resource === "organizations"
      ? [{ id: "org-b", name: "Selected tenant" }] : [] }));
    const createVehicle = jest.fn().mockResolvedValue({ ok: true, vehicle_id: "vehicle-b", organization_id: "org-b" });
    client.mockReturnValue({ listResource, createVehicle });
    render(<VehicleCreateTargetForm {...props} organizationId={null} canSelectOrganization />);
    await waitFor(() => expect(listResource).toHaveBeenCalledTimes(1));
    expect(listResource.mock.calls[0][0]).toBe("organizations");
    expect(screen.queryByTestId("vehicle-create-form")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Selected tenant" }));
    await waitFor(() => expect(listResource).toHaveBeenCalledWith("vehicle_create_branch_directory", { organization_id: "org-b" }, 100, 0, { key: "name", direction: "asc" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Plate number/ }), { target: { value: "QA-TARGET" } });
    fireEvent.submit(screen.getByTestId("vehicle-create-form"));
    await waitFor(() => expect(createVehicle).toHaveBeenCalledWith({ plate_number: "QA-TARGET", organization_id: "org-b" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Created");
  });
});
