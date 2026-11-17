jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}));

jest.mock("../../packages/ui/src/navigate", () => ({
  navigateTo: jest.fn(),
}));

import { screen } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import { WorkflowRunTriggersPanel } from "../../packages/ui/src/workflow-run-triggers-panel";

describe("WorkflowRunTriggersPanel", () => {
  it("renders safe workflow-run trigger links", () => {
    renderWithIntl(
      <WorkflowRunTriggersPanel
        workflowTemplateId="template-a"
        incomingTriggers={[
          {
            id: "in-1",
            enabled: true,
            source_workflow_template_id: "template-b",
            target_workflow_template_id: "template-a",
            source_statuses: ["completed"],
            source_statuses_text: "completed",
          },
        ]}
        outgoingTriggers={[
          {
            id: "out-1",
            enabled: true,
            source_workflow_template_id: "template-a",
            target_workflow_template_id: "template-b",
            source_statuses: ["failed"],
            source_statuses_text: "failed",
          },
        ]}
        workflowTemplates={[
          { id: "template-a", name: "Template A" },
          { id: "template-b", name: "Template B" },
        ]}
        appBasePath="/portal"
      />
    );

    const fullViewLinks = screen.getAllByRole("link", {
      name: "Open workflow-run triggers in full view",
    });
    expect(fullViewLinks).toHaveLength(2);
    expect(fullViewLinks[0]).toHaveAttribute("href", "/portal/resources/workflow_run_triggers?target_workflow_template_id=template-a");
    expect(fullViewLinks[1]).toHaveAttribute("href", "/portal/resources/workflow_run_triggers?source_workflow_template_id=template-a");

    const firesLinks = screen.getAllByRole("link", { name: "Open fires" });
    expect(firesLinks).toHaveLength(2);
    expect(firesLinks[0]).toHaveAttribute("href", "/portal/resources/workflow_trigger_fires?workflow_run_trigger_id=in-1");
    expect(firesLinks[1]).toHaveAttribute("href", "/portal/resources/workflow_trigger_fires?workflow_run_trigger_id=out-1");
  });

  it("hides workflow-run trigger links when appBasePath is unsafe", () => {
    renderWithIntl(
      <WorkflowRunTriggersPanel
        workflowTemplateId="template-a"
        incomingTriggers={[
          {
            id: "in-1",
            enabled: true,
            source_workflow_template_id: "template-b",
            target_workflow_template_id: "template-a",
            source_statuses: ["completed"],
            source_statuses_text: "completed",
          },
        ]}
        outgoingTriggers={[]}
        workflowTemplates={[
          { id: "template-a", name: "Template A" },
          { id: "template-b", name: "Template B" },
        ]}
        appBasePath="javascript:alert(1)"
      />
    );

    expect(
      screen.queryByRole("link", { name: "Open workflow-run triggers in full view" })
    ).toBeNull();
    expect(screen.getAllByText("Open workflow-run triggers in full view")).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "Open fires" })).toBeNull();
    expect(screen.getAllByText("Open fires")).toHaveLength(1);
  });
});
