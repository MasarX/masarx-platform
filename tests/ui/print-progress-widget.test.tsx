import { useState } from "react";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PrintProgressWidget,
  type PrintProgressWidgetStatusSnapshot,
  resolvePrintProgressWidgetHelperText,
  resolvePrintProgressWidgetProgress,
  resolvePrintProgressWidgetStateLabel,
} from "../../packages/ui/src/print-progress-widget";
import { renderWithIntl } from "./test-utils";
import * as en from "../../packages/config/messages/en.json";
import * as ar from "../../packages/config/messages/ar.json";

test.each([
  ["en", "generating"], ["en", "completed"],
  ["ar", "generating"], ["ar", "completed"],
] as const)("print disclosure controls its localized run reference (%s, %s)", async (locale, status) => {
  const previousLocale = process.env.NEXT_PUBLIC_LOCALE;
  process.env.NEXT_PUBLIC_LOCALE = locale;
  const messages = (locale === "ar" ? ar : en).ui.resourceActions.printProgress;
  const runReference = messages.diagnostics.runId.replace("{workflowRunId}", "run-contract");
  function Widget() {
    const [open, setOpen] = useState(false);
    return <PrintProgressWidget testId="print-contract" status={status}
      workflowRunId="run-contract" selectionCount={2} elapsedMs={4011}
      targetDownloadMs={100} targetMiss technicalDetailsOpen={open}
      statusSnapshot={{ freshExpectedCount: 2, freshReadyCount: 2,
        outputSource: "context", timingSource: "stage_execute_ms" }}
      onExpand={() => undefined} onHide={() => undefined} onDismiss={() => undefined}
      onToggleTechnicalDetails={() => setOpen((value) => !value)} />;
  }
  try {
    const user = userEvent.setup();
    renderWithIntl(<Widget />);
    const control = screen.getByRole("button", { name: messages.actions.technicalDetails });
    expect(control).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("print-contract-details")).not.toBeInTheDocument();
    expect(screen.queryByText(runReference)).not.toBeInTheDocument();
    await user.click(control);
    expect(control).toHaveAttribute("aria-expanded", "true");
    const details = screen.getByTestId("print-contract-details");
    expect(details).toBeVisible();
    expect(within(details).getByText(runReference)).toBeVisible();
    expect(details).toHaveTextContent(messages.diagnostics.target.replace("{target}", "100"));
    expect(details).not.toHaveTextContent("stage_execute_ms");
  } finally {
    if (previousLocale === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
    else process.env.NEXT_PUBLIC_LOCALE = previousLocale;
  }
});

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
  expect(screen.queryByText("Activity reference: run-single")).not.toBeInTheDocument();
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

test("print progress widget exposes support details only when expanded", async () => {
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

  await user.click(screen.getByRole("button", { name: "Support details" }));
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

  expect(screen.getByText("Activity reference: run-details")).toBeInTheDocument();
  expect(screen.getByText("Download target: <= 100ms")).toBeInTheDocument();
  expect(screen.getByText("Timing details: Recorded execution timing")).toBeInTheDocument();
  expect(screen.getByText("File source: Saved workflow output")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "View activity" }));
  expect(openRun).toHaveBeenCalled();
});

test.each([
  ["context", "Saved workflow output"],
  ["metadata", "Workflow metadata"],
  ["execute_result", "Execution result"],
  ["step_result", "Step result"],
  ["execute_async_response", "Background execution result"],
  ["async_response", "Background execution result"],
  ["file_path", "Saved file"],
  ["fresh_ready_url", "Newly generated download"],
  ["fresh_ready_file", "Newly generated file"],
  ["workflow_output_download", "Saved workflow output"],
  ["resource_detail", "Workflow record"],
  ["stage_execute_ms", "Recorded execution timing"],
  ["function_total_ms", "Recorded total timing"],
  ["stage_render_ms", "Recorded rendering timing"],
  ["stage_bundle_wait_ms", "Recorded bundle wait timing"],
  ["stage_bundle_ms", "Recorded bundle timing"],
  ["missing", "Not available"],
  ["unknown", "Unknown source"],
  ["future_artifact_output_timer", "Unknown source"],
  ["toString", "Unknown source"],
])("print details present %s without guessing the source", (source, expected) => {
  const statusSnapshot = { outputSource: source, failureReason: "Generation failed" };
  renderWithIntl(<PrintProgressWidget status="failed" workflowRunId="run-source" selectionCount={1}
    elapsedMs={10} targetDownloadMs={100} targetMiss={false} technicalDetailsOpen statusSnapshot={statusSnapshot}
    onExpand={() => undefined} onHide={() => undefined} onDismiss={() => undefined}
    onToggleTechnicalDetails={() => undefined} />);
  expect(screen.getByText(`File source: ${expected}`)).toBeInTheDocument();
  expect(screen.getByText("Generation failed")).toBeInTheDocument();
  expect(statusSnapshot.outputSource).toBe(source);
});

test("print source details use Arabic copy", () => {
  const previousLocale = process.env.NEXT_PUBLIC_LOCALE;
  process.env.NEXT_PUBLIC_LOCALE = "ar";
  try {
    renderWithIntl(<PrintProgressWidget status="completed" workflowRunId="run-ar" selectionCount={1}
      elapsedMs={10} targetDownloadMs={100} targetMiss={false} technicalDetailsOpen
      statusSnapshot={{ outputSource: "context", timingSource: "stage_execute_ms" }}
      onExpand={() => undefined} onHide={() => undefined} onDismiss={() => undefined}
      onToggleTechnicalDetails={() => undefined} />);
    expect(screen.getByText("مرجع النشاط: run-ar")).toBeInTheDocument();
    expect(screen.getByText("مصدر الملف: مخرجات سير عمل محفوظة")).toBeInTheDocument();
    expect(screen.getByText("تفاصيل التوقيت: مدة التنفيذ المسجلة")).toBeInTheDocument();
  } finally {
    if (previousLocale === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
    else process.env.NEXT_PUBLIC_LOCALE = previousLocale;
  }
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

test.each([
  ["partial output", { freshExpectedCount: 3, freshReadyCount: 2 }, "2 of 3 labels are ready.", 67],
  ["pending job", { jobCompletionPending: true }, "Your file is opening now. Label job completion is still syncing.", 100],
  ["pending persistence", { artifactPersisted: false }, "Your file is opening now. Artifact persistence is still syncing.", 100],
] as Array<[string, PrintProgressWidgetStatusSnapshot, string, number]>)("keeps completed download busy for %s backend readback", (_name, snapshot, helper, percent) => {
  renderWithIntl(<PrintProgressWidget status="completed" workflowRunId="run-pending" selectionCount={3}
    elapsedMs={100} targetDownloadMs={100} targetMiss={false} minimized={false} technicalDetailsOpen={false}
    statusSnapshot={snapshot} onExpand={() => undefined} onHide={() => undefined}
    onDismiss={() => undefined} onToggleTechnicalDetails={() => undefined} />);
  expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  expect(screen.getByText(helper)).toBeInTheDocument();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", String(percent));
  expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
});

test("failure remains an atomic assertive terminal alert even with incomplete backend evidence", () => {
  renderWithIntl(<PrintProgressWidget status="failed" workflowRunId="run-failed-proof" selectionCount={3}
    elapsedMs={100} targetDownloadMs={100} targetMiss={false} minimized={false} technicalDetailsOpen={false}
    statusSnapshot={{ artifactPersisted: false, jobCompletionPending: true }}
    onExpand={() => undefined} onHide={() => undefined} onDismiss={() => undefined} onToggleTechnicalDetails={() => undefined} />);
  expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
  expect(screen.getByRole("alert")).toHaveAttribute("aria-atomic", "true");
  expect(screen.getByRole("alert")).not.toHaveAttribute("aria-busy");
});

test("shows only supplied label lineage diagnostics without deriving identities", () => {
  const props = { status: "completed" as const, workflowRunId: "run-lineage", selectionCount: 1,
    elapsedMs: 100, targetDownloadMs: 100, targetMiss: false, minimized: false, technicalDetailsOpen: true,
    onExpand: () => undefined, onHide: () => undefined, onDismiss: () => undefined, onToggleTechnicalDetails: () => undefined };
  const { rerender } = renderWithIntl(<PrintProgressWidget {...props} statusSnapshot={{
    labelJobId: "job-1", labelId: "label-1", labelVersionId: "version-1", activeVersionId: "version-2",
  }} />);
  for (const value of ["Label job: job-1", "Label: label-1", "Label version: version-1", "Active version: version-2"]) {
    expect(screen.getByText(value)).toBeInTheDocument();
  }
  rerender(<PrintProgressWidget {...props} statusSnapshot={{}} />);
  expect(screen.queryByText("Label job: job-1")).not.toBeInTheDocument();
  expect(screen.queryByText("Label: label-1")).not.toBeInTheDocument();
});
