import type { Meta, StoryObj } from "@storybook/react";
import { ContextStrip } from "./context-strip";

const meta: Meta<typeof ContextStrip> = {
  title: "Layout/ContextStrip",
  component: ContextStrip
};

export default meta;
type Story = StoryObj<typeof ContextStrip>;

export const Default: Story = {
  args: {
    userLabel: "iwjxpqiwyuyklntvxxkxvirv@example.invalid",
    orgLabel: "MasarX HQ",
    scopeLabel: "tenant logistics",
    capabilityCount: 14,
    settingsResolutionId: "sr_123"
  }
};
