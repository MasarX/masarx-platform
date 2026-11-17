import type { Meta, StoryObj } from "@storybook/react";
import {
  resolveResourceActionStats,
  type ResourceActionStats
} from "./resource-actions";

const meta: Meta = {
  title: "Resource/ResourceActionStats",
  parameters: {
    docs: {
      description: {
        component:
          "Utility for resolving resource action statistics. " +
          "This story documents the output shape of resolveResourceActionStats."
      }
    }
  }
};

export default meta;
type Story = StoryObj;

export const Default: Story = {
  render: () => {
    const stats: ResourceActionStats = resolveResourceActionStats({
      commands: [],
      userCapabilities: []
    });
    return (
      <pre className="text-xs text-ui-muted">
        {JSON.stringify(stats, null, 2)}
      </pre>
    );
  }
};
