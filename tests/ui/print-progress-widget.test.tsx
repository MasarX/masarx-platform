import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PrintProgressWidget,
  resolvePrintProgressWidgetHelperText,
  resolvePrintProgressWidgetProgress,
  resolvePrintProgressWidgetStateLabel,
} from "../../packages/ui/src/print-progress-widget";
import { renderWithIntl } from "./test-utils";

test("print progress widget renders plain-language single-label active copy", () => {
  renderWithIntl(
    <PrintProgressWidget
      status="generating"
      workflowRunId="run-single"
      selectionCount={1}
      elapsedMs={420}
      targetDownloadMs={100}
      targetMiss
      minimized={false}
      technicalDetailsOpen={false}
      statusSnapshot={{
        freshExpectedCount: 1,
        freshReadyCount: 0,
      }}
      onExpand={() => undefined}
      onHide={() => undefined}
      onDismiss={() => undefined}
      onRetry={() => undefined}
      onToggleTechnicalDetails={() => undefined}
      onOpenRun={() => undefined}
    />
  );

  expect(screen.getByText("Printing label")).toBeInTheDocument();
  expect(screen.getByText("Creating your label")).toBeInTheDocument();
  expect(
    screen.getByText("We're generating a fresh label for this shipment.")
  ).toBeInTheDocument();
  expect(screen.queryByText("Workflow run: run-single")).not.toBeInTheDocument();
});

test("print progress widget renders determinate progress for multi-label counts", () => {
  renderWithIntl(
    <PrintProgressWidget
      status="generating"
      workflowRunId="run-multi"
      selectionCount={24}
      elapsedMs={2180}
      targetDownloadMs={100}
      targetMiss
      minimized={false}
      technicalDetailsOpen={false}
      statusSnapshot={{
        freshExpectedCount: 24,
        freshReadyCount: 18,
      }}
      onExpand={() => undefined}
      onHide={() => undefined}
      onDismiss={() => undefined}
      onRetry={() => undefined}
      onToggleTechnicalDetails={() => undefined}
      onOpenRun={() => undefined}
    />
  );

  expect(screen.getByText("Printing 24 labels")).toBeInTheDocument();
  expect(screen.getByText("18 of 24 labels are ready.")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "Creating labels" })).toHaveAttribute(
    "aria-valuenow",
    "75"
  );
});

test("print progress widget exposes technical details only when expanded", async () => {
  const user = userEvent.setup();
  const toggle = jest.fn();
  const openRun = jest.fn();

  const { rerender } = renderWithIntl(
    <PrintProgressWidget
      status="completed"
      workflowRunId="run-details"
      selectionCount={2}
      elapsedMs={4011}
      targetDownloadMs={100}
      targetMiss
      minimized={false}
      technicalDetailsOpen={false}
      runOutputsHref="/workflows/runs/run-details#outputs"
      statusSnapshot={{
        freshExpectedCount: 2,
        freshReadyCount: 2,
        outputSource: "context",
        timingSource: "stage_execute_ms",
        artifactPersisted: true,
        jobCompletionPending: false,
      }}
      onExpand={() => undefined}
      onHide={() => undefined}
      onDismiss={() => undefined}
      onRetry={() => undefined}
      onToggleTechnicalDetails={toggle}
      onOpenRun={openRun}
    />
  );

  await user.click(screen.getByRole("button", { name: "Technical details" }));
  expect(toggle).toHaveBeenCalled();

  rerender(
    <PrintProgressWidget
      status="completed"
      workflowRunId="run-details"
      selectionCount={2}
      elapsedMs={4011}
      targetDownloadMs={100}
      targetMiss
      minimized={false}
      technicalDetailsOpen
      runOutputsHref="/workflows/runs/run-details#outputs"
      statusSnapshot={{
        freshExpectedCount: 2,
        freshReadyCount: 2,
        outputSource: "context",
        timingSource: "stage_execute_ms",
        artifactPersisted: true,
        jobCompletionPending: false,
      }}
      onExpand={() => undefined}
      onHide={() => undefined}
      onDismiss={() => undefined}
      onRetry={() => undefined}
      onToggleTechnicalDetails={toggle}
      onOpenRun={openRun}
    />
  );

  expect(screen.getByText("Workflow run: run-details")).toBeInTheDocument();
  expect(screen.getByText("Download target: <= 100ms")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "View run" }));
  expect(openRun).toHaveBeenCalled();
});

test("print progress widget renders minimized pill and expand action", async () => {
  const user = userEvent.setup();
  const expand = jest.fn();

  renderWithIntl(
    <PrintProgressWidget
      status="completed"
      workflowRunId="run-pill"
      selectionCount={1}
      elapsedMs={3210}
      targetDownloadMs={100}
      targetMiss
      minimized
      technicalDetailsOpen={false}
      statusSnapshot={{
        freshExpectedCount: 1,
        freshReadyCount: 1,
      }}
      onExpand={expand}
      onHide={() => undefined}
      onDismiss={() => undefined}
      onRetry={() => undefined}
      onToggleTechnicalDetails={() => undefined}
      onOpenRun={() => undefined}
    />
  );

  await user.click(screen.getByRole("button", { name: /Download started/i }));
  expect(expand).toHaveBeenCalled();
});

test("print progress widget shows retry action for failures", async () => {
  const user = userEvent.setup();
  const retry = jest.fn();

  renderWithIntl(
    <PrintProgressWidget
      status="failed"
      workflowRunId="run-failed"
      selectionCount={1}
      elapsedMs={5400}
      targetDownloadMs={100}
      targetMiss
      minimized={false}
      technicalDetailsOpen={false}
      statusSnapshot={{
        failureReason: "Your browser blocked the download window. Allow popups, then try again.",
      }}
      onExpand={() => undefined}
      onHide={() => undefined}
      onDismiss={() => undefined}
      onRetry={retry}
      onToggleTechnicalDetails={() => undefined}
      onOpenRun={() => undefined}
    />
  );

  expect(screen.getByText("Couldn't prepare download")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Your browser blocked the download window. Allow popups, then try again."
    )
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalled();
});

test("print progress helpers keep single and multi behavior stable", () => {
  expect(resolvePrintProgressWidgetStateLabel("queued", 1)).toBe(
    "Preparing your download"
  );
  expect(
    resolvePrintProgressWidgetHelperText({
      status: "generating",
      selectionCount: 24,
      freshExpectedCount: 24,
      freshReadyCount: 12,
    })
  ).toBe("12 of 24 labels are ready.");
  expect(
    resolvePrintProgressWidgetProgress({
      status: "generating",
      selectionCount: 24,
      freshExpectedCount: 24,
      freshReadyCount: 12,
    })
  ).toEqual({ determinate: true, percent: 50 });
});
