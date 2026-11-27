import { screen } from "@testing-library/react";
import portalEn from "../../apps/portal/messages/en.json";
import { createUiTranslator } from "../../packages/ui/src/i18n";
import { createWorkflowRunProvenanceLabels } from "../../packages/ui/src/workflow-run-provenance-labels";
import { WorkflowRunProvenancePanel } from "../../packages/ui/src/workflow-run-provenance-panel";
import { renderWithIntl } from "./test-utils";

const labels = createWorkflowRunProvenanceLabels(
  createUiTranslator(undefined, { locale: "en", messages: portalEn }),
  { keyPrefix: "observability.workflowRun.provenance" },
);

it.each([
  [{ trigger_source: "task" }, labels.sources.task],
  [{ trigger_source: "workflow_run_trigger" }, labels.sources.workflowRunTrigger],
  [{ trigger_source: "schedule" }, labels.sources.schedule],
  [{ trigger_source: "schedule_manual" }, labels.sources.scheduleManual],
  [{ trigger_source: "worker", trigger_type: "workflow_run_trigger" }, labels.sources.workflowRunTrigger],
])("renders the workflow provenance for %j", (context, label) => {
  renderWithIntl(
    <WorkflowRunProvenancePanel workflowRun={{ context }} appBasePath="/portal" labels={labels} />,
  );
  expect(screen.getByText(`${labels.triggeredVia} ${label}`)).toBeInTheDocument();
});
