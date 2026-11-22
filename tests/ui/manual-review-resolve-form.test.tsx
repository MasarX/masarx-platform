import { fireEvent, render, screen, within } from "@testing-library/react";
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

jest.mock("../../packages/ui/src/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

test("manual review resolve form emits submit telemetry", () => {
  formState = { status: "idle", message: undefined };
  const action = jest.fn(async () => ({ status: "success" as const }));
  render(
    <ManualReviewResolveForm
      action={action}
      taskId="task-1"
      outcomeOptions={[
        { value: "approved", label: "Approved by policy" },
        { value: "rejected", label: "Rejected by policy" },
      ]}
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

test("manual review outcome uses labels while notes stay an approved free-text exception", () => {
  formState = { status: "idle", message: undefined };
  render(
    <ManualReviewResolveForm
      action={async () => ({ status: "success" as const })}
      taskId="task-1"
      testIdPrefix="manual-review-readable"
    />
  );

  const outcome = screen.getByTestId("manual-review-readable-outcome") as HTMLSelectElement;
  const notes = screen.getByTestId("manual-review-readable-notes") as HTMLTextAreaElement;

  expect(outcome.tagName).toBe("SELECT");
  expect(outcome).toHaveDisplayValue("outcome.placeholder");

  fireEvent.change(outcome, { target: { value: "approved" } });
  expect(outcome.value).toBe("approved");
  expect(outcome.selectedOptions[0]?.text).toBe("outcome.approved");
  expect(outcome.selectedOptions[0]?.text).not.toBe("approved");
  expect(notes.tagName).toBe("TEXTAREA");
  expect(notes.name).toBe("resolution_notes");
});

test("manual review resolve form emits result telemetry on error", () => {
  formState = { status: "idle", message: undefined };
  const action = jest.fn(async () => ({ status: "error" as const }));
  const view = render(
    <ManualReviewResolveForm
      action={action}
      taskId="task-1"
      outcomeOptions={[
        { value: "approved", label: "Approved by policy" },
        { value: "rejected", label: "Rejected by policy" },
      ]}
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
      outcomeOptions={[
        { value: "approved", label: "Approved by policy" },
        { value: "rejected", label: "Rejected by policy" },
      ]}
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

test("manual review resolve form renders lookup-provided outcome labels", () => {
  formState = { status: "idle", message: undefined };
  const action = jest.fn(async () => ({ status: "success" as const }));
  const taskId = "33333333-3333-4333-8333-333333333333";
  render(
    <ManualReviewResolveForm
      action={action}
      taskId={taskId}
      outcomeOptions={[
        { value: "approved", label: "Approve after evidence review" },
        { value: "rejected", label: "Reject after policy check" },
      ]}
      testIdPrefix="manual-review"
    />
  );

  const form = screen.getByTestId("manual-review-form") as HTMLFormElement;
  const select = screen.getByTestId("manual-review-outcome") as HTMLSelectElement;
  expect(within(select).getByRole("option", { name: "Approve after evidence review" })).toHaveValue("approved");
  expect(within(select).getByRole("option", { name: "Reject after policy check" })).toHaveValue("rejected");
  expect(within(select).queryByRole("option", { name: "approved" })).toBeNull();
  expect(within(select).queryByRole("option", { name: "rejected" })).toBeNull();
  expect(select).toHaveTextContent("Approve after evidence review");
  expect(select).toHaveTextContent("Reject after policy check");
  fireEvent.change(select, { target: { value: "approved" } });
  expect(select).toHaveValue("approved");
  expect(select).toHaveDisplayValue("Approve after evidence review");
  expect(select).not.toHaveDisplayValue("approved");
  const taskInput = form.querySelector<HTMLInputElement>('input[name="task_id"]');
  expect(taskInput).toHaveAttribute("type", "hidden");
  expect(taskInput).toHaveValue(taskId);
  expect(screen.queryByText(taskId)).toBeNull();
  const formData = new FormData(form);
  expect(formData.get("task_id")).toBe(taskId);
  expect(formData.get("resolution_outcome")).toBe("approved");
  expect(select).not.toHaveTextContent("outcome.approved");
});
