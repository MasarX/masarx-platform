import type { Meta, StoryObj } from "@storybook/react";

/**
 * WorkflowRunLogsPanel is a complex client component with deep dependencies
 * on workflow run data models, replay logic, and studio actions.
 * This documentation story captures its API and usage.
 */

function WorkflowRunLogsPanelDocumentation() {
  return (
    <div className="space-y-4 p-6 text-sm text-ui-ink">
      <h2 className="text-lg font-semibold">WorkflowRunLogsPanel</h2>
      <p>
        Displays workflow run execution logs with step-by-step detail,
        filtering, search, JSON preview, and batch replay capabilities.
      </p>
      <h3 className="font-semibold mt-4">Key Props</h3>
      <ul className="list-disc pl-5 space-y-1">
        <li><code>steps</code> &mdash; Array of workflow run log steps</li>
        <li><code>templateSteps</code> &mdash; Template step definitions for filtering</li>
        <li><code>labels</code> &mdash; i18n labels for tabs, filters, and empty states</li>
        <li><code>replayConfig</code> &mdash; Configuration for step replay actions</li>
        <li><code>onReplay</code> &mdash; Callback for single-step replay</li>
        <li><code>onBatchReplay</code> &mdash; Callback for batch replay of issue steps</li>
      </ul>
      <h3 className="font-semibold mt-4">Features</h3>
      <ul className="list-disc pl-5 space-y-1">
        <li>Tabbed view: All steps, Issues only, Timeline</li>
        <li>Step-level JSON input/output preview</li>
        <li>Copy and download step data</li>
        <li>Issue count badges per template step</li>
        <li>Batch replay for failed/issue steps</li>
      </ul>
    </div>
  );
}

const meta: Meta<typeof WorkflowRunLogsPanelDocumentation> = {
  title: "Domain/WorkflowRunLogsPanel",
  component: WorkflowRunLogsPanelDocumentation,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Workflow run logs panel with step detail, filtering, JSON preview, " +
          "and replay capabilities. Complex dependency tree prevents direct rendering.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof WorkflowRunLogsPanelDocumentation>;

export const Documentation: Story = {};
