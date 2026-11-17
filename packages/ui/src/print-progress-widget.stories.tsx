import type { Meta, StoryObj } from "@storybook/react";
import {
  PrintProgressWidget,
  type PrintProgressWidgetProps,
} from "./print-progress-widget";

const baseArgs: PrintProgressWidgetProps = {
  status: "generating",
  workflowRunId: "run_demo_123",
  selectionCount: 1,
  elapsedMs: 840,
  targetDownloadMs: 100,
  targetMiss: true,
  minimized: false,
  technicalDetailsOpen: false,
  runOutputsHref: "/workflows/runs/run_demo_123#outputs",
  statusSnapshot: {
    freshExpectedCount: 1,
    freshReadyCount: 0,
    outputSource: "context",
    timingSource: "stage_execute_ms",
    artifactPersisted: false,
    jobCompletionPending: true,
  },
  onExpand: () => undefined,
  onHide: () => undefined,
  onDismiss: () => undefined,
  onRetry: () => undefined,
  onToggleTechnicalDetails: () => undefined,
  onOpenRun: () => undefined,
};

const meta: Meta<typeof PrintProgressWidget> = {
  title: "Resource/PrintProgressWidget",
  component: PrintProgressWidget,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Floating status widget for shipment label printing. Renders a compact, user-facing download assistant while keeping workflow diagnostics collapsed.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="min-h-[80vh] bg-ui-surface/40 p-6">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof PrintProgressWidget>;

export const SingleActive: Story = {
  args: {
    ...baseArgs,
    status: "generating",
    selectionCount: 1,
  },
};

export const MultiProgress: Story = {
  args: {
    ...baseArgs,
    status: "generating",
    selectionCount: 24,
    elapsedMs: 2480,
    statusSnapshot: {
      freshExpectedCount: 24,
      freshReadyCount: 18,
      outputSource: "context",
      timingSource: "stage_render_ms",
      artifactPersisted: false,
      jobCompletionPending: true,
    },
  },
};

export const CompletedMinimized: Story = {
  args: {
    ...baseArgs,
    status: "completed",
    selectionCount: 24,
    elapsedMs: 4180,
    minimized: true,
    statusSnapshot: {
      freshExpectedCount: 24,
      freshReadyCount: 24,
      outputSource: "context",
      timingSource: "stage_execute_ms",
      artifactPersisted: true,
      jobCompletionPending: false,
    },
  },
};

export const CompletedExpanded: Story = {
  args: {
    ...baseArgs,
    status: "completed",
    selectionCount: 24,
    elapsedMs: 4180,
    minimized: false,
    technicalDetailsOpen: false,
    statusSnapshot: {
      freshExpectedCount: 24,
      freshReadyCount: 24,
      outputSource: "context",
      timingSource: "stage_execute_ms",
      artifactPersisted: true,
      jobCompletionPending: false,
    },
  },
};

export const FailedWithDiagnostics: Story = {
  args: {
    ...baseArgs,
    status: "failed",
    selectionCount: 2,
    elapsedMs: 6180,
    technicalDetailsOpen: true,
    statusSnapshot: {
      failureReason: "Your browser blocked the download window. Allow popups, then try again.",
      freshExpectedCount: 2,
      freshReadyCount: 2,
      outputSource: "context",
      timingSource: "stage_bundle_ms",
      artifactPersisted: true,
      jobCompletionPending: false,
    },
  },
};
