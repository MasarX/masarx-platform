import type { Meta, StoryObj } from "@storybook/react";
import {
  ContextNoticeDiagnostics,
  type ContextNoticeDiagnosticsEntry
} from "./context-notice-diagnostics";

const meta: Meta<typeof ContextNoticeDiagnostics> = {
  title: "Feedback/ContextNoticeDiagnostics",
  component: ContextNoticeDiagnostics
};

export default meta;
type Story = StoryObj<typeof ContextNoticeDiagnostics>;

const defaultEntries: ContextNoticeDiagnosticsEntry[] = [
  { label: "Request ID", value: "req_abc123", copyValue: "req_abc123" },
  { label: "Status", value: "200 OK" },
  { label: "Endpoint", value: "/api/v1/orders", monospace: true }
];

export const Default: Story = {
  args: {
    entries: defaultEntries
  }
};

export const SingleEntry: Story = {
  args: {
    entries: [{ label: "Request ID", value: "req_abc123", copyValue: "req_abc123" }]
  }
};

export const WithMonospace: Story = {
  args: {
    entries: [
      { label: "Endpoint", value: "/api/v1/orders", monospace: true },
      { label: "Method", value: "POST", monospace: true }
    ]
  }
};
