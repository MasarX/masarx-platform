import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { ErrorBoundary } from "./error-boundary";

const meta: Meta<typeof ErrorBoundary> = {
  title: "Feedback/ErrorBoundary",
  component: ErrorBoundary
};

export default meta;
type Story = StoryObj<typeof ErrorBoundary>;

export const Healthy: Story = {
  render: () => (
    <ErrorBoundary fallback={<div>Something went wrong.</div>}>
      <p>Everything is working fine.</p>
    </ErrorBoundary>
  )
};

export const Fallback: Story = {
  render: () => (
    <div className="rounded-xl border border-ui-border bg-ui-surface p-4 text-sm text-ui-muted">
      Something went wrong.
    </div>
  )
};
