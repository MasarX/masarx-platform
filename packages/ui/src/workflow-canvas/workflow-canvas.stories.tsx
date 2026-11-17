import type { Meta, StoryObj } from "@storybook/react";
import { WorkflowCanvas } from "./workflow-canvas";

const meta: Meta<typeof WorkflowCanvas> = {
  title: "Workflow/Canvas",
  component: WorkflowCanvas,
  decorators: [
    (Story) => (
      <div style={{ width: "100%", height: "600px", border: "1px solid #e5e7eb", borderRadius: "16px", overflow: "hidden" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof WorkflowCanvas>;

const SAMPLE_STEPS: Record<string, unknown>[] = [
  {
    id: "step-1",
    operation_name: "validate_input",
    handler_key: "handler_validate_v1",
    enabled: true,
    manual_action_required: false,
    transition_condition: "always",
    next_operation_name: "transform_data",
    next_operation_priority: 10,
    next_operation_delay_seconds: 0,
    condition_jsonlogic: null,
    metadata: null,
  },
  {
    id: "step-2",
    operation_name: "transform_data",
    handler_key: "handler_transform_v2",
    enabled: true,
    manual_action_required: false,
    transition_condition: "always",
    next_operation_name: "send_notification",
    next_operation_priority: 10,
    next_operation_delay_seconds: 5,
    condition_jsonlogic: null,
    metadata: { format: "json" },
  },
  {
    id: "step-3",
    operation_name: "send_notification",
    handler_key: "handler_notify_v1",
    enabled: true,
    manual_action_required: false,
    transition_condition: "always",
    next_operation_name: null,
    next_operation_priority: null,
    next_operation_delay_seconds: null,
    condition_jsonlogic: null,
    metadata: null,
  },
];

const SAMPLE_TRIGGERS: Record<string, unknown>[] = [
  {
    webhook_source_id: "ws-1",
    source_identifier: "webhook-orders",
    name: "Order Webhook",
    provider_type: "generic",
    enabled: true,
  },
];

export const ThreeStepChain: Story = {
  args: {
    steps: SAMPLE_STEPS,
    idKey: "id",
    triggers: null,
    runs: null,
  },
};

export const WithTrigger: Story = {
  args: {
    steps: SAMPLE_STEPS,
    idKey: "id",
    triggers: SAMPLE_TRIGGERS,
    runs: null,
  },
};

export const WithRunPreview: Story = {
  args: {
    steps: SAMPLE_STEPS,
    idKey: "id",
    triggers: SAMPLE_TRIGGERS,
    runs: [
      {
        id: "run-1",
        workflow_template_id: "wf-1",
        status: "completed",
        started_at: "2026-02-22T10:00:00Z",
        completed_at: "2026-02-22T10:01:30Z",
        run_steps: [
          { workflow_template_step_id: "step-1", status: "completed", duration_ms: 120 },
          { workflow_template_step_id: "step-2", status: "completed", duration_ms: 5400 },
          { workflow_template_step_id: "step-3", status: "failed", duration_ms: 890 },
        ],
      },
    ],
  },
};

export const InProgressRun: Story = {
  args: {
    steps: SAMPLE_STEPS,
    idKey: "id",
    triggers: SAMPLE_TRIGGERS,
    runs: [
      {
        id: "run-2",
        workflow_template_id: "wf-1",
        status: "in_progress",
        started_at: "2026-02-22T11:00:00Z",
        completed_at: null,
        run_steps: [
          { workflow_template_step_id: "step-1", status: "completed", duration_ms: 95 },
          { workflow_template_step_id: "step-2", status: "in_progress", duration_ms: null },
          { workflow_template_step_id: "step-3", status: "pending", duration_ms: null },
        ],
      },
    ],
  },
};

export const EmptyCanvas: Story = {
  args: {
    steps: [],
    idKey: "id",
    triggers: null,
    runs: null,
    onAddFirstStep: () => {
      // eslint-disable-next-line no-console
      console.log("Add first step clicked");
    },
  },
};

export const SingleStep: Story = {
  args: {
    steps: [SAMPLE_STEPS[0]!],
    idKey: "id",
    triggers: null,
    runs: null,
  },
};

export const DisabledStep: Story = {
  args: {
    steps: [
      { ...SAMPLE_STEPS[0]!, enabled: false },
      SAMPLE_STEPS[1]!,
      SAMPLE_STEPS[2]!,
    ],
    idKey: "id",
    triggers: null,
    runs: null,
  },
};

const LARGE_STEPS: Record<string, unknown>[] = Array.from({ length: 8 }, (_, i) => {
  const ops = [
    "receive_order", "validate_address", "check_inventory", "calculate_shipping",
    "process_payment", "generate_label", "notify_warehouse", "send_confirmation",
  ];
  const nextOp = i < 7 ? ops[i + 1]! : null;
  return {
    id: `step-${i + 1}`,
    operation_name: ops[i]!,
    handler_key: `handler_${ops[i]}_v1`,
    enabled: true,
    manual_action_required: i === 4,
    transition_condition: "always",
    next_operation_name: nextOp,
    next_operation_priority: 10,
    next_operation_delay_seconds: i === 3 ? 30 : 0,
    condition_jsonlogic: null,
    metadata: null,
  };
});

export const LargeWorkflow: Story = {
  args: {
    steps: LARGE_STEPS,
    idKey: "id",
    triggers: SAMPLE_TRIGGERS,
    runs: null,
  },
};
