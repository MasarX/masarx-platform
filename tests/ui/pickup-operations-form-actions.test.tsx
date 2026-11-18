import { fireEvent, screen, waitFor } from "@testing-library/react";
import { PickupMutationForm, type PickupMutationFormField } from "../../packages/ui/src/pickup-operations-form";
import { renderWithIntl } from "./test-utils";

// Real React action state (no useActionState mock): native form reset runs after every action commit.
const fields: PickupMutationFormField[] = [
  { name: "reason", label: "Reason", kind: "text", defaultValue: "Original" },
  { name: "status", label: "Status", kind: "select", defaultValue: "open", options: [
    { value: "open", label: "Open" }, { value: "closed", label: "Closed" }] },
];

function edit() {
  fireEvent.change(screen.getByTestId("pickup-reason"), { target: { value: "Changed" } });
  fireEvent.change(screen.getByTestId("pickup-status"), { target: { value: "closed" } });
}

test("text/select callers reset only after each successful action", async () => {
  const action = jest.fn(async () => ({ status: "success" as const, message: "Saved" }));
  renderWithIntl(<PickupMutationForm action={action} submitLabel="Save" testIdPrefix="pickup" fields={fields} />);
  for (const attempt of [1, 2]) {
    edit();
    fireEvent.submit(screen.getByTestId("pickup-form"));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(attempt));
    expect(action.mock.calls[attempt - 1][1].get("reason")).toBe("Changed");
    expect(action.mock.calls[attempt - 1][1].get("status")).toBe("closed");
    await waitFor(() => expect(screen.getByTestId("pickup-reason")).toHaveValue("Original"));
    expect(screen.getByTestId("pickup-status")).toHaveValue("open");
  }
});

test("text/select callers retain entered data across consecutive failed actions", async () => {
  const action = jest.fn(async () => ({ status: "error" as const, message: "Operation denied" }));
  renderWithIntl(<PickupMutationForm action={action} submitLabel="Save" testIdPrefix="pickup" fields={fields} />);
  edit();
  for (const attempt of [1, 2]) {
    fireEvent.submit(screen.getByTestId("pickup-form"));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(attempt));
    await waitFor(() => expect(screen.getByTestId("pickup-error")).toHaveTextContent("Operation denied"));
    await waitFor(() => expect(screen.getByTestId("pickup-status")).toHaveValue("closed"));
    expect(screen.getByTestId("pickup-reason")).toHaveValue("Changed");
  }
});
