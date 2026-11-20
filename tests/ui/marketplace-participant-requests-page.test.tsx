import type React from "react";
import { render, screen } from "@testing-library/react";
import { createUiServerClient } from "@masarx/api/server";
import { MarketplaceParticipantRequestsPage } from "../../packages/ui/src/marketplace-participant-requests-page";

let capturedResourcePageProps: Record<string, unknown> | null = null;
let capturedReviewFormProps: Record<string, unknown> | null = null;
let detailFooterPayload: {
  detailId: string;
  detail: Record<string, unknown>;
  detailError?: string | null;
} | null = null;

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
      <div data-testid="marketplace-participant-requests-resource-page">
        {detailFooterPayload && renderDetailFooter
          ? renderDetailFooter(detailFooterPayload)
          : null}
      </div>
    );
  },
}));

jest.mock("../../packages/ui/src/marketplace-participant-review-form", () => ({
  MarketplaceParticipantReviewForm: (props: Record<string, unknown>) => {
    capturedReviewFormProps = props;
    return <div data-testid={`${String(props.testIdPrefix ?? "marketplace-participant-review")}-mock`} />;
  },
}));

const mockedCreateUiServerClient = createUiServerClient as jest.Mock;
const marketplaceDecisionRows = [
  { value: "approved", label: "Approve marketplace participant" },
  { value: "rejected", label: "Reject marketplace participant" },
];

describe("MarketplaceParticipantRequestsPage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    capturedResourcePageProps = null;
    capturedReviewFormProps = null;
    detailFooterPayload = {
      detailId: "550e8400-e29b-41d4-a716-446655440001",
      detail: {
        status: "rejected",
        review_decision: "rejected",
        requested_participant_type_key: "freelancer_driver",
        review_reason: "Verification mismatch",
        reviewed_by: "ops@example.com",
      },
    };
  });

  it("renders user-friendly status and participant labels instead of raw keys", async () => {
    const listLookupValues = jest.fn().mockResolvedValue(marketplaceDecisionRows);
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({
        capabilities: ["marketplace_participant_requests.review"],
      }),
      listLookupValues,
    });

    const node = await MarketplaceParticipantRequestsPage({
      appKey: "console",
      searchParams: {},
      appBasePath: "/console",
      baseHref: "/console/marketplace/participant-requests",
      testIdPrefix: "console-marketplace-participant-requests",
    });

    render(node as React.ReactElement);

    expect(capturedResourcePageProps).toEqual(
      expect.objectContaining({
        resourceKey: "marketplace_participant_requests",
        searchParams: expect.objectContaining({
          status: "pending",
        }),
      }),
    );

    expect(listLookupValues).toHaveBeenCalledWith("marketplace_participant_request_review_decision");
    expect(screen.getAllByText("Rejected").length).toBeGreaterThan(0);
    expect(screen.getByText("Freelancer Driver")).toBeInTheDocument();
    expect(screen.queryByText("freelancer_driver")).not.toBeInTheDocument();
    expect(screen.getByText("Verification mismatch")).toBeInTheDocument();
    expect(capturedReviewFormProps).toEqual(
      expect.objectContaining({
        requestId: "550e8400-e29b-41d4-a716-446655440001",
        decisionOptions: marketplaceDecisionRows,
        disabled: true,
        disabledMessage: "This request has already been processed.",
        testIdPrefix: "console-marketplace-participant-requests-review",
      }),
    );
  });
});
