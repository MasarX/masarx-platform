import type { Meta, StoryObj } from "@storybook/react";
import { resolveStatusIcon } from "./status-icon";
import { Badge } from "./badge";

function StatusIconShowcase({ statuses }: { statuses: string[] }) {
  return (
    <div className="space-y-2">
      {statuses.map((status) => {
        const result = resolveStatusIcon(status);
        return (
          <div key={status} className="flex items-center gap-3">
            <span className="w-32 text-sm font-mono text-ui-muted">{status}</span>
            {result ? (
              <Badge tone={result.tone}>
                <span className="flex items-center gap-1">
                  {result.icon}
                  {status}
                </span>
              </Badge>
            ) : (
              <span className="text-xs text-ui-muted">No match</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

const meta: Meta<typeof StatusIconShowcase> = {
  title: "Feedback/StatusIcon",
  component: StatusIconShowcase,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Resolves the appropriate tone and icon for a status string. " +
          "Maps keywords to success/warning/danger/info tones with matching icons.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof StatusIconShowcase>;

export const SuccessStatuses: Story = {
  args: {
    statuses: [
      "active", "healthy", "delivered", "completed", "success",
      "approved", "enabled", "done", "verified", "confirmed",
    ],
  },
};

export const WarningStatuses: Story = {
  args: {
    statuses: [
      "pending", "processing", "scheduled", "planned", "queued",
      "waiting", "in_progress", "draft", "paused",
    ],
  },
};

export const DangerStatuses: Story = {
  args: {
    statuses: [
      "failed", "error", "cancelled", "rejected", "expired",
      "disabled", "blocked", "critical",
    ],
  },
};

export const InfoStatuses: Story = {
  args: {
    statuses: [
      "in_transit", "transit", "shipped", "dispatched", "sent",
      "running", "syncing",
    ],
  },
};

export const UnknownStatus: Story = {
  args: {
    statuses: ["custom_status", "xyz", ""],
  },
};
