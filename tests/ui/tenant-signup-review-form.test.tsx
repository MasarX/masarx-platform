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
      requestId="fd2aef73-39b0-4b16-a5f5-365d7af8a2cb"
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
      requestId="fd2aef73-39b0-4b16-a5f5-365d7af8a2cb"
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
      requestId="fd2aef73-39b0-4b16-a5f5-365d7af8a2cb"
      defaultInviteRedirectTo="https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback"
      testIdPrefix="tenant-signup"
    />,
  );

  expect(screen.getByText("Invite redirect (required for approval)")).toBeInTheDocument();
  expect(screen.getByDisplayValue("https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback")).toBeInTheDocument();
});
