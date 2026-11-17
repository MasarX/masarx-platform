import type { Meta, StoryObj } from "@storybook/react";
import { ScopeSelector } from "./scope-selector";

const meta: Meta<typeof ScopeSelector> = {
  title: "Label Designer/ScopeSelector",
  component: ScopeSelector,
  args: {
    prefix: "ld",
    scopeOptions: [
      { key: "tenant:org-abc123", scopeType: "tenant", scopeId: "org-abc123", label: "Tenant \u2022 org-abc1" },
      { key: "client:cl-001", scopeType: "client", scopeId: "cl-001", label: "Client \u2022 Acme Corp" },
      { key: "sender:sn-001", scopeType: "sender", scopeId: "sn-001", label: "Sender \u2022 Fast Logistics" },
    ],
    selectedScopeKey: "tenant:org-abc123",
    organizationId: "org-abc12345-6789-full-uuid",
    scopeLoading: false,
    onScopeChange: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof ScopeSelector>;

export const Default: Story = {};

export const Loading: Story = {
  args: { scopeLoading: true },
};

export const SingleScope: Story = {
  args: {
    scopeOptions: [
      { key: "tenant:org-abc123", scopeType: "tenant", scopeId: "org-abc123", label: "Tenant \u2022 org-abc1" },
    ],
  },
};
