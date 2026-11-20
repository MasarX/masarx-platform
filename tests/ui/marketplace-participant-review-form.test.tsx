import { fireEvent, render, screen } from "@testing-library/react";
import { MarketplaceParticipantReviewForm } from "../../packages/ui/src/marketplace-participant-review-form";

let formState: { status: "idle" | "error" | "success"; message?: string } = { status: "idle" };
let pending = false;
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  useActionState: () => [formState, "/", pending],
}));

beforeEach(() => { formState = { status: "idle" }; pending = false; });
const props = { action: jest.fn(), requestId: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830", testIdPrefix: "review" };

test("request-documents exposes a labelled document list without changing approve/reject", () => {
  render(<MarketplaceParticipantReviewForm {...props} />);
  expect(screen.queryByLabelText("Requested document types")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Decision"), { target: { value: "request_additional_docs" } });
  expect(screen.getByLabelText("Requested document types")).toHaveAttribute("name", "requested_documents");
  expect(screen.getByLabelText("Requested document types")).toHaveAccessibleDescription(/One document type per line/);
  expect(screen.getByLabelText("Reason")).not.toBeRequired();
  fireEvent.change(screen.getByLabelText("Decision"), { target: { value: "approved" } });
  expect(screen.queryByLabelText("Requested document types")).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Reject" })).toHaveValue("rejected");
});

test.each(["disabled", "pending"])("%s review cannot double-submit", state => {
  pending = state === "pending";
  render(<MarketplaceParticipantReviewForm {...props} disabled={state === "disabled"} />);
  expect(screen.getByLabelText("Decision")).toBeDisabled();
  expect(screen.getByTestId("review-submit")).toBeDisabled();
});

test.each(["error", "success"] as const)("%s result is announced", status => {
  formState = { status, message: "Owned review result" };
  render(<MarketplaceParticipantReviewForm {...props} />);
  expect(screen.getByRole(status === "error" ? "alert" : "status")).toHaveTextContent("Owned review result");
});

test("marketplace participant review form renders lookup-provided decision labels", () => {
  formState = { status: "idle", message: undefined };
  const action = jest.fn(async () => ({ status: "success" as const }));
  const requestId = "00000000-0000-4000-8000-000000000150";
  const participantTypeKey = "freelancer_driver";

  render(
    <MarketplaceParticipantReviewForm
      action={action}
      requestId={requestId}
      participantTypeKey={participantTypeKey}
      decisionOptions={[
        { value: "approved", label: "Approve verified participant" },
        { value: "rejected", label: "Reject participant request" },
      ]}
      testIdPrefix="marketplace-review"
    />,
  );

  const select = screen.getByTestId("marketplace-review-decision");
  const form = screen.getByTestId("marketplace-review-form");
  const hiddenRequestId = form.querySelector<HTMLInputElement>('input[name="request_id"]');
  const hiddenParticipantType = form.querySelector<HTMLInputElement>(
    'input[name="participant_type_key"]',
  );
  const approveOption = select.querySelector<HTMLOptionElement>('option[value="approved"]');
  const rejectOption = select.querySelector<HTMLOptionElement>('option[value="rejected"]');

  expect(select).toHaveTextContent("Approve verified participant");
  expect(select).toHaveTextContent("Reject participant request");
  expect(approveOption?.textContent).toBe("Approve verified participant");
  expect(rejectOption?.textContent).toBe("Reject participant request");
  expect(select).not.toHaveTextContent("approved");
  expect(select).not.toHaveTextContent("rejected");
  expect(screen.queryByText("Approve")).not.toBeInTheDocument();
  expect(screen.queryByText("Reject")).not.toBeInTheDocument();
  expect(hiddenRequestId?.type).toBe("hidden");
  expect(hiddenRequestId?.value).toBe(requestId);
  expect(hiddenParticipantType?.type).toBe("hidden");
  expect(hiddenParticipantType?.value).toBe(participantTypeKey);
  expect(screen.queryByText(requestId)).not.toBeInTheDocument();
  expect(screen.queryByText(participantTypeKey)).not.toBeInTheDocument();
});
