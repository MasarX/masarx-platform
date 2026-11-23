import { fireEvent, screen, within } from "@testing-library/react";
import {
  PickupMutationForm,
  type PickupMutationFormField,
  type PickupMutationFormState,
} from "../../packages/ui/src/pickup-operations-form";
import { renderWithIntl } from "./test-utils";

let formState: PickupMutationFormState = { status: "idle" };
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  useActionState: () => [formState, "/submit", false],
}));

const fields: PickupMutationFormField[] = [
  { name: "client_id", kind: "hidden", defaultValue: "scoped-client" },
  { name: "reference", kind: "text", label: "Reference", defaultValue: "initial reference" },
  { name: "notes", kind: "textarea", label: "Notes", defaultValue: "initial notes" },
  {
    name: "status", kind: "select", label: "Status", defaultValue: "planned",
    options: [{ value: "planned", label: "Planned" }, { value: "active", label: "Active" }],
  },
];
const action = async (): Promise<PickupMutationFormState> => ({ status: "idle" });
const form = () => (
  <PickupMutationForm action={action} submitLabel="Save" testIdPrefix="pickup" fields={fields} />
);

describe("PickupMutationForm same-context outcome state", () => {
  beforeEach(() => { formState = { status: "idle" }; });

  it("retains typed values after an error outcome without changing scoped defaults", () => {
    const view = renderWithIntl(form());
    fireEvent.change(screen.getByTestId("pickup-reference"), { target: { value: "typed reference" } });
    fireEvent.change(screen.getByTestId("pickup-notes"), { target: { value: "typed notes" } });
    fireEvent.change(screen.getByTestId("pickup-status"), { target: { value: "active" } });

    formState = { status: "error", message: "Please retry" };
    view.rerender(form());

    expect(screen.getByTestId("pickup-error")).toHaveTextContent("Please retry");
    expect(screen.getByRole("alert")).toHaveTextContent("Please retry");
    expect(screen.getByTestId("pickup-reference")).toHaveValue("typed reference");
    expect(screen.getByTestId("pickup-notes")).toHaveValue("typed notes");
    expect(screen.getByTestId("pickup-status")).toHaveValue("active");
    expect(view.container.querySelector('input[name="client_id"]')).toHaveValue("scoped-client");
  });

  it("resets edited values to the same scoped defaults after a success outcome", () => {
    const view = renderWithIntl(form());
    fireEvent.change(screen.getByTestId("pickup-reference"), { target: { value: "typed reference" } });
    fireEvent.change(screen.getByTestId("pickup-notes"), { target: { value: "typed notes" } });
    fireEvent.change(screen.getByTestId("pickup-status"), { target: { value: "active" } });

    formState = { status: "success", message: "Saved" };
    view.rerender(form());

    expect(screen.getByTestId("pickup-success")).toHaveTextContent("Saved");
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(screen.getByTestId("pickup-reference")).toHaveValue("initial reference");
    expect(screen.getByTestId("pickup-notes")).toHaveValue("initial notes");
    expect(screen.getByTestId("pickup-status")).toHaveValue("planned");
    expect(view.container.querySelector('input[name="client_id"]')).toHaveValue("scoped-client");
  });
});

describe("PickupMutationForm readable relationships", () => {
  beforeEach(() => { formState = { status: "idle" }; });
  const relationFields: PickupMutationFormField[] = [
    { name: "client_id", label: "Client", kind: "relation", required: true, defaultValue: "client-a",
      options: [{ value: "client-a", label: "Client A" }, { value: "client-b", label: "Client B" }] },
    { name: "sender_id", label: "Sender", kind: "relation", dependsOn: "client_id", defaultValue: "sender-a",
      options: [{ value: "sender-a", label: "Sender A", groupValue: "client-a" }, { value: "sender-b", label: "Sender B", groupValue: "client-b" }] },
    { name: "shipment_ids", label: "Pickup requests", kind: "relation", mode: "multi", required: true,
      options: [{ value: "shipment-a", label: "TRACK-001" }, { value: "shipment-b", label: "TRACK-002" }] },
  ];
  const relations = () => <PickupMutationForm action={action} submitLabel="Save" testIdPrefix="relations" fields={relationFields} />;
  it("submits canonical IDs, clears a sender outside the newly selected client, and retains error selections", () => {
    const view = renderWithIntl(relations());
    fireEvent.click(within(screen.getByTestId("relations-client_id")).getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "Client B" }));
    expect(within(screen.getByTestId("relations-client_id")).getByRole("combobox")).toHaveTextContent("Client B");
    expect(view.container.querySelector('input[name="client_id"]')).toHaveValue("client-b");
    expect(view.container.querySelector('input[name="sender_id"]')).toHaveValue("");
    fireEvent.click(within(screen.getByTestId("relations-shipment_ids")).getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "TRACK-001" }));
    expect(view.container.querySelector('input[name="shipment_ids"]')).toHaveValue("shipment-a");
    expect(new FormData(screen.getByTestId("relations-form") as HTMLFormElement).getAll("shipment_ids"))
      .toEqual(["shipment-a"]);
    fireEvent.submit(screen.getByTestId("relations-form"));
    formState = { status: "error", message: "Capacity changed" };
    view.rerender(relations());
    expect(view.container.querySelector('input[name="client_id"]')).toHaveValue("client-b");
    expect(view.container.querySelector('input[name="shipment_ids"]')).toHaveValue("shipment-a");
  });
  it("rejects an empty required multi-selection before invoking the server action", () => {
    renderWithIntl(relations());
    expect(fireEvent.submit(screen.getByTestId("relations-form"))).toBe(false);
    expect(screen.getByTestId("relations-error")).toHaveTextContent("Select Pickup requests");
  });
  it("keeps authorized records outside the bounded loaded choices reachable by explicit ID entry", () => {
    const view = renderWithIntl(relations());
    fireEvent.change(screen.getByLabelText("Client IDs"), { target: { value: "client-201" } });
    fireEvent.change(screen.getByLabelText("Pickup requests IDs"), { target: { value: "shipment-101, shipment-102" } });
    expect(view.container.querySelector('input[name="client_id"]')).toHaveValue("client-201");
    expect(Array.from(view.container.querySelectorAll('input[name="shipment_ids"]')).map((input) => (input as HTMLInputElement).value))
      .toEqual(["shipment-101", "shipment-102"]);
  });
  it("clears old tenant selections and hides their lookup choices after target organization changes", () => {
    const view = renderWithIntl(<PickupMutationForm action={action} submitLabel="Save" testIdPrefix="scoped" fields={[
      { name: "organization_id", kind: "text", label: "Organization", defaultValue: "org-a" },
      { name: "driver_user_id", label: "Driver", kind: "relation", defaultValue: "driver-a", options: [{ value: "driver-a", label: "Org A driver" }] },
    ]} />);
    fireEvent.change(screen.getByTestId("scoped-organization_id"), { target: { value: "org-b" } });
    expect(view.container.querySelector('input[name="driver_user_id"]')).toHaveValue("");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Driver" }), { key: "Enter" });
    expect(screen.queryByRole("option", { name: "Org A driver" })).not.toBeInTheDocument();
  });
});
