import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomerShipmentChangeReviewForm } from "../../packages/ui/src/customer-shipment-change-review-form";
import { renderWithIntl } from "./test-utils";

const rpcMock = jest.fn();
const refreshMock = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: () => ({ rpc: rpcMock }),
}));

beforeEach(() => {
  rpcMock.mockReset();
  refreshMock.mockReset();
});

async function submitApproval(response: unknown, reason?: string) {
  rpcMock.mockResolvedValue(response);
  const user = userEvent.setup();
  renderWithIntl(
    <CustomerShipmentChangeReviewForm
      supportCaseId="case-1"
      testIdPrefix="shipment-review"
    />,
  );
  if (reason) await user.type(screen.getByTestId("shipment-review-reason"), reason);
  await user.click(screen.getByTestId("shipment-review-approve"));
}

test("review controls are disabled before hydration", () => {
  const markup = renderToStaticMarkup(
    <CustomerShipmentChangeReviewForm
      supportCaseId="case-1"
      testIdPrefix="shipment-review"
    />
  );
  const document = new DOMParser().parseFromString(markup, "text/html");

  for (const testId of [
    "shipment-review-reason",
    "shipment-review-approve",
    "shipment-review-reject",
  ]) {
    expect(
      document.querySelector(`[data-testid="${testId}"]`)?.hasAttribute("disabled")
    ).toBe(true);
  }
});

test.each([undefined, "Customer confirmed the corrected delivery address"])(
  "accepts only a matching canonical terminal readback with reason %s",
  async (reason) => {
  await submitApproval({
    ok: true,
    outcome: "applied",
    support_case_id: "case-1",
    current_snapshot: { tracking_number: "MX-1", shipment_status: "created" },
  }, reason);

  await waitFor(() =>
    expect(rpcMock).toHaveBeenCalledWith("public_tracking_review_request_v1", {
      p_input: {
        support_case_id: "case-1",
        decision: "approved",
        reason: reason ?? null,
      },
    }),
  );
  expect(await screen.findByTestId("shipment-review-success")).toHaveTextContent(
    "Shipment change approved and applied.",
  );
  expect(screen.getByTestId("shipment-review-blocked")).toHaveTextContent(
    "This shipment change is already resolved.",
  );
  expect(screen.getByTestId("shipment-review-approve")).toBeDisabled();
  expect(screen.getByTestId("shipment-review-reject")).toBeDisabled();
  // Keep the current canonical server readback refresh, not a browser reload.
  expect(refreshMock).toHaveBeenCalledTimes(1);
});

test.each([
  ["null payload", null],
  ["missing ok", { outcome: "applied", support_case_id: "case-1", current_snapshot: { id: "s-1" } }],
  ["mismatched request", { ok: true, outcome: "applied", support_case_id: "case-2", current_snapshot: { id: "s-1" } }],
  ["missing snapshot", { ok: true, outcome: "applied", support_case_id: "case-1", current_snapshot: {} }],
  ["non-terminal outcome", { ok: true, outcome: "pending_review", support_case_id: "case-1", current_snapshot: { id: "s-1" } }],
  ["non-object error", { ok: true, error: "apply_failed", outcome: "applied", support_case_id: "case-1", current_snapshot: { id: "s-1" } }],
])("fails closed on %s", async (_label, response) => {
  await submitApproval(response);

  expect(await screen.findByTestId("shipment-review-error")).toHaveTextContent(
    "did not return a matching canonical readback",
  );
  expect(screen.queryByTestId("shipment-review-success")).not.toBeInTheDocument();
});
