import type { Meta, StoryObj } from "@storybook/react";

/**
 * WorkflowTemplateStepsBuilder is a complex client component with deep
 * dependencies on AJV, react-query, and the full API client.
 * This documentation story captures its API surface.
 */

function WorkflowTemplateStepsBuilderDocumentation() {
  return (
    <div className="space-y-4 p-6 text-sm text-ui-ink">
      <h2 className="text-lg font-semibold">WorkflowTemplateStepsBuilder</h2>
      <p>
        Visual builder for workflow template steps with drag-and-drop reordering,
        step configuration via JSON Schema forms, and validation.
      </p>
      <h3 className="font-semibold mt-4">Key Props</h3>
      <ul className="list-disc pl-5 space-y-1">
        <li><code>steps</code> &mdash; Current step definitions</li>
        <li><code>onChange</code> &mdash; Callback when steps are modified</li>
        <li><code>operationTemplates</code> &mdash; Available operation types</li>
        <li><code>capabilities</code> &mdash; User capabilities for gating</li>
        <li><code>disabled</code> &mdash; Read-only mode</li>
      </ul>
      <h3 className="font-semibold mt-4">Features</h3>
      <ul className="list-disc pl-5 space-y-1">
        <li>Add, remove, and reorder steps</li>
        <li>Per-step configuration via JSON Schema forms</li>
        <li>Step validation with inline error display</li>
        <li>Keyboard shortcuts for step management</li>
        <li>Schema-driven input widgets</li>
      </ul>
    </div>
  );
}

const meta: Meta<typeof WorkflowTemplateStepsBuilderDocumentation> = {
  title: "Domain/WorkflowTemplateStepsBuilder",
  component: WorkflowTemplateStepsBuilderDocumentation,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Visual builder for workflow template steps. Complex dependency tree " +
          "(AJV, react-query, API client) prevents direct Storybook rendering.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof WorkflowTemplateStepsBuilderDocumentation>;

export const Documentation: Story = {};
