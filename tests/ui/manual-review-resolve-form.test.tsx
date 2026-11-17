import { fireEvent, render, screen } from "@testing-library/react";
import { ManualReviewResolveForm } from "../../packages/ui/src/manual-review-resolve-form";
import { reportUiEvent } from "../../packages/ui/src/reporting";

let formState = { status: "idle" as const, message: undefined as string | undefined };

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

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

test("manual review resolve form emits submit telemetry", () => {
  formState = { status: "idle", message: undefined };
  const action = jest.fn(async () => ({ status: "success" as const }));
  render(
    <ManualReviewResolveForm
      action={action}
      taskId="task-1"
      testIdPrefix="manual-review"
      telemetry={{
        settingsResolutionId: "res-1",
        scopeType: "tenant",
        scopeId: "scope-1",
        scopeValue: "org-a",
      }}
    />
  );

  fireEvent.submit(screen.getByTestId("manual-review-form"));

  expect(reportUiEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "ui.manual_review.resolve.submit",
      name: "submit",
      digest: "res-1",
      meta: {
        settingsResolutionId: "res-1",
        scopeType: "tenant",
        scopeId: "scope-1",
        scopeValue: "org-a",
      },
    })
  );
});

test("manual review resolve form emits result telemetry on error", () => {
  formState = { status: "idle", message: undefined };
  const action = jest.fn(async () => ({ status: "error" as const }));
  const view = render(
    <ManualReviewResolveForm
      action={action}
      taskId="task-1"
      testIdPrefix="manual-review"
      telemetry={{
        settingsResolutionId: "res-2",
        scopeType: "tenant",
        scopeId: "scope-9",
        scopeValue: "org-b",
      }}
    />
  );

  formState = { status: "error", message: "Failed to resolve" };
  view.rerender(
    <ManualReviewResolveForm
      action={action}
      taskId="task-1"
      testIdPrefix="manual-review"
      telemetry={{
        settingsResolutionId: "res-2",
        scopeType: "tenant",
        scopeId: "scope-9",
        scopeValue: "org-b",
      }}
    />
  );

  expect(reportUiEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "ui.manual_review.resolve.result",
      name: "error",
      message: "Failed to resolve",
      digest: "res-2",
      meta: {
        settingsResolutionId: "res-2",
        scopeType: "tenant",
        scopeId: "scope-9",
        scopeValue: "org-b",
      },
    })
  );
});
