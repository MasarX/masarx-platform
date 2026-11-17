import { render, screen } from "@testing-library/react";
import { ShipmentAmendCancelForm } from "../../packages/ui/src/shipment-amend-cancel-form";

let formState = { status: "idle" as const, message: undefined as string | undefined, locked: false };

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
    formState = { status: "idle", message: undefined, locked: false };
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
    expect(screen.getByLabelText("Saudi short address (optional)")).toHaveAttribute("name", "sa_short_code");
    expect(screen.getByLabelText("Latitude (optional)")).toHaveAttribute("name", "latitude");
    expect(screen.getByLabelText("Longitude (optional)")).toHaveAttribute("name", "longitude");
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

    formState = { status: "success", message: "Shipment soft-cancel completed.", locked: false };
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

  it("locks all amendment operations after an accepted or uncertain submission", () => {
    formState = { status: "idle", message: undefined, locked: true };
    render(<ShipmentAmendCancelForm action={action} shipmentId="4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"
      options={{ operations: { modify: { allowed: true }, address: { allowed: true }, cancel: { allowed: true },
        reschedule: { allowed: true } } }} currentValues={{}} testIdPrefix="locked" />);
    expect(screen.getByTestId("locked-address-submit")).toBeDisabled();
    expect(screen.getByTestId("locked-modify-submit")).toBeDisabled();
    expect(screen.getByTestId("locked-cancel-submit")).toBeDisabled();
    expect(screen.getByTestId("locked-reschedule-submit")).toBeDisabled();
    expect(screen.getByTestId("locked-address-short-code")).toBeDisabled();
  });
  it.each([
    ["restricted", ["service_type"], true],
    ["empty", [], false],
    ["absent", undefined, false],
    ["null", null, false],
    ["scalar", "service_type", false],
    ["object", { service_type: true }, false],
    ["untrimmed", [" service_type "], false],
  ] as Array<[string, unknown, boolean]>)("honors %s modify field policy without broadening it", (_name, fields, serviceAllowed) => {
    render(<ShipmentAmendCancelForm action={action} shipmentId="4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"
      options={{ operations: { modify: { allowed: true } }, policy: { modify_allowed_fields: fields as string[] } }}
      currentValues={{}} testIdPrefix="policy" />);
    const service = screen.getByTestId("policy-modify-service-type");
    if (serviceAllowed) expect(service).toBeEnabled();
    else expect(service).toBeDisabled();
    for (const field of ["service-level", "client-reference", "carrier-reference", "special-instructions", "cod-amount", "metadata", "references"]) {
      expect(screen.getByTestId(`policy-modify-${field}`)).toBeDisabled();
    }
  });

  it("explains missing operation availability and preserves the submission lock", () => {
    formState = { status: "idle", message: undefined, locked: true };
    render(<ShipmentAmendCancelForm action={action} shipmentId="4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"
      options={{ operations: { modify: { allowed: true } }, policy: { modify_allowed_fields: ["service_type"] } }}
      currentValues={{}} testIdPrefix="policy" />);
    expect(screen.getByTestId("policy-modify-service-type")).toBeDisabled();
    expect(screen.getByTestId("policy-modify-submit")).toBeDisabled();
    expect(screen.getByText(/address availability was not returned by the backend/)).toBeInTheDocument();
    expect(screen.getByTestId("policy-address-submit")).toBeDisabled();
  });

});
