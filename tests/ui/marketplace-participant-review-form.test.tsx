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
