import { render, screen } from "@testing-library/react";
import { ShipmentAmendCancelForm } from "../../packages/ui/src/shipment-amend-cancel-form";

let formState = { status: "idle" as const, message: undefined as string | undefined };

jest.mock("react", () => {
  const actual = jest.requireActual("react");
  return {
    ...actual,
    useActionState: () => [formState, "/submit", false],
  };
});

describe("ShipmentAmendCancelForm", () => {
  const action = jest.fn(async () => ({ status: "success" as const }));

  beforeEach(() => {
    formState = { status: "idle", message: undefined };
    action.mockClear();
  });

  it("renders structured address inputs required by the canonical address handler", () => {
    render(
      <ShipmentAmendCancelForm
        action={action}
        shipmentId="4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"
        options={{
          lock_source: "shipment_operation_policy",
          operations: {
            modify: { allowed: true, allowed_statuses: ["pending"] },
            reschedule: { allowed: true, allowed_statuses: ["pending"] },
            address: { allowed: true, allowed_statuses: ["pending"] },
            cancel: { allowed: true, allowed_statuses: ["pending"], window_hours: 24 },
          },
        }}
        currentValues={{
          trackingNumber: "TRK-123",
          status: "pending",
          promisedDeliveryDate: "2026-03-19",
          addressCountry: "AE",
        }}
        testIdPrefix="shipment-amend-cancel"
      />,
    );

    expect(screen.getByTestId("shipment-amend-cancel-address-line1")).toBeInTheDocument();
    expect(screen.getByTestId("shipment-amend-cancel-address-city")).toBeInTheDocument();
    expect(screen.getByTestId("shipment-amend-cancel-address-country")).toBeInTheDocument();
    expect(screen.getByTestId("shipment-amend-cancel-address-directions")).toBeInTheDocument();
    expect(screen.getByTestId("shipment-amend-cancel-address-country")).toHaveValue("AE");
  });

  it("shows shipment_operation_policy block messaging when cancel is not allowed", () => {
    render(
      <ShipmentAmendCancelForm
        action={action}
        shipmentId="4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"
        options={{
          lock_source: "shipment_operation_policy",
          operations: {
            modify: { allowed: true, allowed_statuses: ["pending"] },
            reschedule: { allowed: true, allowed_statuses: ["pending"] },
            address: { allowed: true, allowed_statuses: ["pending"] },
            cancel: {
              allowed: false,
              reason: "shipment_delete_window_expired",
              allowed_statuses: ["pending"],
              window_hours: 24,
            },
          },
          policy: {
            delete_window_hours: 24,
          },
        }}
        currentValues={{
          trackingNumber: "TRK-123",
          status: "pending",
        }}
        testIdPrefix="shipment-amend-cancel"
      />,
    );

    expect(
      screen.getByText(
        "Blocked by shipment_operation_policy: cancel is limited to the first 24 hours after creation.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("shipment-amend-cancel-cancel-submit")).toBeDisabled();
  });

  it("shows status-based blocking for reschedule operations", () => {
    render(
      <ShipmentAmendCancelForm
        action={action}
        shipmentId="4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"
        options={{
          lock_source: "shipment_operation_policy",
          operations: {
            modify: { allowed: true, allowed_statuses: ["pending"] },
            reschedule: {
              allowed: false,
              reason: "shipment_status_not_allowed",
              allowed_statuses: ["pending", "created"],
            },
            address: { allowed: true, allowed_statuses: ["pending"] },
            cancel: { allowed: true, allowed_statuses: ["pending"], window_hours: 24 },
          },
        }}
        currentValues={{
          trackingNumber: "TRK-123",
          status: "dispatched",
        }}
        testIdPrefix="shipment-amend-cancel"
      />,
    );

    expect(
      screen.getByText(
        "Blocked by shipment_operation_policy: reschedule is limited to statuses pending, created.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("shipment-amend-cancel-reschedule-submit")).toBeDisabled();
  });

  it("keeps soft-cancel enabled when the policy allows it", () => {
    render(
      <ShipmentAmendCancelForm
        action={action}
        shipmentId="4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"
        options={{
          lock_source: "shipment_operation_policy",
          operations: {
            modify: { allowed: true, allowed_statuses: ["pending"] },
            reschedule: { allowed: true, allowed_statuses: ["pending"] },
            address: { allowed: true, allowed_statuses: ["pending"] },
            cancel: { allowed: true, allowed_statuses: ["pending"], window_hours: 24 },
          },
        }}
        currentValues={{
          trackingNumber: "TRK-123",
          status: "pending",
        }}
        testIdPrefix="shipment-amend-cancel"
      />,
    );

    expect(screen.getByTestId("shipment-amend-cancel-cancel-submit")).toBeEnabled();
    expect(screen.getByText("Tracking:")).toBeInTheDocument();
  });

  it("falls back to the policy-backed country default when the shipment has no current address country", () => {
    render(
      <ShipmentAmendCancelForm
        action={action}
        shipmentId="4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"
        options={{
          lock_source: "shipment_operation_policy",
          operations: {
            modify: { allowed: true, allowed_statuses: ["pending"] },
            reschedule: { allowed: true, allowed_statuses: ["pending"] },
            address: { allowed: true, allowed_statuses: ["pending"] },
            cancel: { allowed: true, allowed_statuses: ["pending"], window_hours: 24 },
          },
          policy: {
            address_default_country_code: "QA",
          },
        }}
        currentValues={{
          trackingNumber: "TRK-123",
          status: "pending",
        }}
        testIdPrefix="shipment-amend-cancel"
      />,
    );

    expect(screen.getByTestId("shipment-amend-cancel-address-country")).toHaveValue("QA");
  });

  it("renders success feedback from the action state", () => {
    const view = render(
      <ShipmentAmendCancelForm
        action={action}
        shipmentId="4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"
        options={{
          lock_source: "shipment_operation_policy",
          operations: {
            modify: { allowed: true, allowed_statuses: ["pending"] },
            reschedule: { allowed: true, allowed_statuses: ["pending"] },
            address: { allowed: true, allowed_statuses: ["pending"] },
            cancel: { allowed: true, allowed_statuses: ["pending"], window_hours: 24 },
          },
        }}
        currentValues={{
          trackingNumber: "TRK-123",
          status: "pending",
        }}
        testIdPrefix="shipment-amend-cancel"
      />,
    );

    formState = { status: "success", message: "Shipment soft-cancel completed." };
    view.rerender(
      <ShipmentAmendCancelForm
        action={action}
        shipmentId="4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"
        options={{
          lock_source: "shipment_operation_policy",
          operations: {
            modify: { allowed: true, allowed_statuses: ["pending"] },
            reschedule: { allowed: true, allowed_statuses: ["pending"] },
            address: { allowed: true, allowed_statuses: ["pending"] },
            cancel: { allowed: true, allowed_statuses: ["pending"], window_hours: 24 },
          },
        }}
        currentValues={{
          trackingNumber: "TRK-123",
          status: "pending",
        }}
        testIdPrefix="shipment-amend-cancel"
      />,
    );

    expect(screen.getByTestId("shipment-amend-cancel-success")).toHaveTextContent(
      "Shipment soft-cancel completed.",
    );
  });
});
