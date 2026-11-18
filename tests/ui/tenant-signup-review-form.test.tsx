import { fireEvent, render, screen } from "@testing-library/react";
import { TenantSignupReviewForm } from "../../packages/ui/src/tenant-signup-review-form";
import { reportUiEvent } from "../../packages/ui/src/reporting";

let formState = { status: "idle" as const, message: undefined as string | undefined };

jest.mock("react", () => {
  const actual = jest.requireActual("react");
  return {
    ...actual,
    useActionState: () => [formState, "/"],
  };
});

jest.mock("../../packages/ui/src/reporting", () => {
  const actual = jest.requireActual("../../packages/ui/src/reporting");
  return {
    ...actual,
    reportUiEvent: jest.fn(),
  };
});

jest.mock("../../packages/ui/src/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

test("tenant signup review form emits submit telemetry", () => {
  formState = { status: "idle", message: undefined };
  const action = jest.fn(async () => ({ status: "success" as const }));

  render(
    <TenantSignupReviewForm
      action={action}
      requestId="4f3e8ae5-f9f4-4fb1-baa1-943ca0d0bb77"
      decisionOptions={[
        { value: "approved", label: "Approve tenant onboarding" },
        { value: "rejected", label: "Reject tenant onboarding" },
      ]}
      testIdPrefix="tenant-signup"
      telemetry={{
        settingsResolutionId: "res-1",
        scopeType: "platform",
        scopeId: null,
        scopeValue: null,
      }}
    />,
  );

  fireEvent.submit(screen.getByTestId("tenant-signup-form"));

  expect(reportUiEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "ui.tenant_signup.review.submit",
      name: "submit",
      digest: "res-1",
      meta: {
        settingsResolutionId: "res-1",
        scopeType: "platform",
      },
    }),
  );
});

test("tenant signup review form emits result telemetry on error", () => {
  formState = { status: "idle", message: undefined };
  const action = jest.fn(async () => ({ status: "error" as const }));

  const view = render(
    <TenantSignupReviewForm
      action={action}
      requestId="00000000-0000-4000-8000-000000000149"
      decisionOptions={[
        { value: "approved", label: "Approve tenant onboarding" },
        { value: "rejected", label: "Reject tenant onboarding" },
      ]}
      testIdPrefix="tenant-signup"
      telemetry={{
        settingsResolutionId: "res-2",
        scopeType: "platform",
        scopeId: null,
        scopeValue: null,
      }}
    />,
  );

  formState = { status: "error", message: "Review failed" };

  view.rerender(
    <TenantSignupReviewForm
      action={action}
      requestId="00000000-0000-4000-8000-000000000149"
      decisionOptions={[
        { value: "approved", label: "Approve tenant onboarding" },
        { value: "rejected", label: "Reject tenant onboarding" },
      ]}
      testIdPrefix="tenant-signup"
      telemetry={{
        settingsResolutionId: "res-2",
        scopeType: "platform",
        scopeId: null,
        scopeValue: null,
      }}
    />,
  );

  expect(reportUiEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "ui.tenant_signup.review.result",
      name: "error",
      message: "Review failed",
      digest: "res-2",
      meta: {
        settingsResolutionId: "res-2",
        scopeType: "platform",
      },
    }),
  );
});

test("tenant signup review form renders approval redirect guidance", () => {
  formState = { status: "idle", message: undefined };
  const action = jest.fn(async () => ({ status: "success" as const }));

  render(
    <TenantSignupReviewForm
      action={action}
      requestId="00000000-0000-4000-8000-000000000149"
      decisionOptions={[
        { value: "approved", label: "Approve tenant onboarding" },
        { value: "rejected", label: "Reject tenant onboarding" },
      ]}
      defaultInviteRedirectTo="https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback"
      testIdPrefix="tenant-signup"
    />,
  );

  expect(screen.getByText("Invite redirect (required for approval)")).toBeInTheDocument();
  expect(screen.getByDisplayValue("https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback")).toBeInTheDocument();
});

test("tenant signup review form renders lookup-provided decision labels", () => {
  formState = { status: "idle", message: undefined };
  const action = jest.fn(async () => ({ status: "success" as const }));
  const requestId = "00000000-0000-4000-8000-000000000149";

  render(
    <TenantSignupReviewForm
      action={action}
      requestId={requestId}
      decisionOptions={[
        { value: "approved", label: "Approve and provision tenant" },
        { value: "rejected", label: "Reject with onboarding reason" },
      ]}
      testIdPrefix="tenant-signup"
    />,
  );

  const select = screen.getByTestId("tenant-signup-decision");
  const form = screen.getByTestId("tenant-signup-form");
  const hiddenRequestId = form.querySelector<HTMLInputElement>('input[name="request_id"]');
  const approveOption = select.querySelector<HTMLOptionElement>('option[value="approved"]');
  const rejectOption = select.querySelector<HTMLOptionElement>('option[value="rejected"]');

  expect(select).toHaveTextContent("Approve and provision tenant");
  expect(select).toHaveTextContent("Reject with onboarding reason");
  expect(approveOption?.textContent).toBe("Approve and provision tenant");
  expect(rejectOption?.textContent).toBe("Reject with onboarding reason");
  expect(select).not.toHaveTextContent("approved");
  expect(select).not.toHaveTextContent("rejected");
  expect(select).not.toHaveTextContent("Approve</option>");
  expect(hiddenRequestId).toBeTruthy();
  expect(hiddenRequestId?.type).toBe("hidden");
  expect(hiddenRequestId?.value).toBe(requestId);
  expect(screen.queryByText(requestId)).not.toBeInTheDocument();
});
