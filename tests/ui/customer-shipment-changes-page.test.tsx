import type React from "react";
import { render, screen } from "@testing-library/react";
import { createUiServerClient } from "@masarx/api/server";
import { CustomerShipmentChangesPage } from "../../packages/ui/src/customer-shipment-changes-page";

let capturedResourcePageProps: Record<string, unknown> | null = null;
let capturedReviewFormProps: Record<string, unknown> | null = null;
let detailFooterPayload: {
  detailId: string;
  detail: Record<string, unknown>;
  detailError?: string | null;
} | null = null;

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    ...props
  }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

jest.mock("../../packages/ui/src/resource-page", () => ({
  ResourcePage: (props: Record<string, unknown>) => {
    capturedResourcePageProps = props;
    const renderDetailFooter = props.renderDetailFooter as
      | ((args: {
          detailId: string;
          detail: Record<string, unknown>;
          detailError?: string | null;
        }) => React.ReactNode)
      | undefined;
    return (
      <div data-testid="customer-shipment-changes-resource-page">
        {props.headerActions}
        {detailFooterPayload && renderDetailFooter
          ? renderDetailFooter(detailFooterPayload)
          : null}
      </div>
    );
  },
}));

jest.mock("../../packages/ui/src/customer-shipment-change-review-form", () => ({
  CustomerShipmentChangeReviewForm: (props: Record<string, unknown>) => {
    capturedReviewFormProps = props;
    return <div data-testid={`${String(props.testIdPrefix ?? "customer-shipment-change-review")}-mock`} />;
  },
}));

const mockedCreateUiServerClient = createUiServerClient as jest.Mock;
const approvalStatusDecisionRows = [
  { value: "approved", label: "Approve and apply change" },
  { value: "rejected", label: "Reject customer change" },
  { value: "pending", label: "Pending review" },
];

describe("CustomerShipmentChangesPage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    capturedResourcePageProps = null;
    capturedReviewFormProps = null;
    detailFooterPayload = {
      detailId: "550e8400-e29b-41d4-a716-446655440000",
      detail: {
        request_type_key: "location_change",
        request_outcome: "pending_review",
        requester_channel: "public_tracking",
        shipment_status_snapshot: "out_for_delivery",
        change_summary: "Customer requested a safer drop-off point.",
        changed_fields: ["address.raw_input", "address.drop_point"],
        metadata: {
          before_snapshot: {
            address: {
              raw_input: "Old tower entrance",
              drop_point: "Reception",
            },
          },
          requested_snapshot: {
            address: {
              raw_input: "New tower visitor entrance",
              drop_point: "Loading dock",
            },
          },
          current_snapshot: {
            address: {
              raw_input: "Old tower entrance",
              drop_point: "Reception",
            },
          },
        },
        status: "open",
      },
    };
  });

  it("passes canonical public-tracking review filters and renders user-friendly review details", async () => {
    const listLookupValues = jest.fn().mockResolvedValue(approvalStatusDecisionRows);
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({
        capabilities: ["manual_review.resolve"],
      }),
      listLookupValues,
    });

    const node = await CustomerShipmentChangesPage({
      appKey: "console",
      searchParams: {},
      appBasePath: "/console",
      baseHref: "/console/operations/customer-shipment-changes",
      reviewQueueHref: "/console/reviews",
      testIdPrefix: "console-customer-shipment-changes",
    });

    render(node as React.ReactElement);

    expect(listLookupValues).toHaveBeenCalledWith("approval_status");
    expect(capturedResourcePageProps).toEqual(
      expect.objectContaining({
        resourceKey: "customer_shipment_changes",
        searchParams: expect.objectContaining({
          request_source: "public_tracking",
        }),
      })
    );
    expect(screen.getByRole("link", { name: "Needs review" })).toHaveAttribute(
      "href",
      "/console/operations/customer-shipment-changes?request_source=public_tracking&request_outcome=pending_review&status=open"
    );
    expect(screen.getAllByText("Needs review").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Location change").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Public Tracking").length).toBeGreaterThan(0);
    expect(screen.getByText("Shipment status: Out For Delivery")).toBeInTheDocument();
    expect(screen.getAllByText("Requested address").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Drop-point details").length).toBeGreaterThan(0);
    expect(screen.queryByText("public_tracking")).not.toBeInTheDocument();
    expect(screen.queryByText("out_for_delivery")).not.toBeInTheDocument();
    expect(screen.getByText("New tower visitor entrance")).toBeInTheDocument();
    expect(screen.getByText("Loading dock")).toBeInTheDocument();
    expect(capturedReviewFormProps).toEqual(
      expect.objectContaining({
        supportCaseId: "550e8400-e29b-41d4-a716-446655440000",
        disabled: false,
        decisionOptions: [
          { value: "approved", label: "Approve and apply change" },
          { value: "rejected", label: "Reject customer change" },
        ],
        testIdPrefix: "console-customer-shipment-changes-review",
      })
    );
  });

  it("blocks the review action when the reviewer is missing manual review capability", async () => {
    const listLookupValues = jest.fn().mockResolvedValue(approvalStatusDecisionRows);
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({
        capabilities: [],
      }),
      listLookupValues,
    });

    const node = await CustomerShipmentChangesPage({
      appKey: "portal",
      searchParams: {},
      appBasePath: "/portal",
      baseHref: "/portal/operations/customer-shipment-changes",
      reviewQueueHref: "/portal/reviews",
      testIdPrefix: "portal-customer-shipment-changes",
    });

    render(node as React.ReactElement);

    expect(capturedReviewFormProps).toEqual(
      expect.objectContaining({
        supportCaseId: "550e8400-e29b-41d4-a716-446655440000",
        disabled: true,
        disabledMessage: "Your account is missing manual_review.resolve capability.",
        decisionOptions: [
          { value: "approved", label: "Approve and apply change" },
          { value: "rejected", label: "Reject customer change" },
        ],
        testIdPrefix: "portal-customer-shipment-changes-review",
      })
    );
  });
});
