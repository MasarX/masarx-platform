import type { Meta, StoryObj } from "@storybook/react";
import { AccessPolicyRequestForm } from "./access-policy-request-form";

const meta: Meta<typeof AccessPolicyRequestForm> = {
  title: "Domain/AccessPolicyRequestForm",
  component: AccessPolicyRequestForm,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Form for requesting access policy changes. Includes an inline " +
          "policy editor, change summary diff, and server action submission.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof AccessPolicyRequestForm>;

const samplePolicy = {
  roles: [
    { key: "operator", label: "Operator", capabilities: ["shipments:read", "orders:read"] },
  ],
  assignments: [],
  deny: [],
};

export const Default: Story = {
  args: {
    action: async () => ({ status: "idle" as const }),
    defaultPolicyJson: JSON.stringify(samplePolicy, null, 2),
    testIdPrefix: "access-request",
  },
};

export const WithScope: Story = {
  args: {
    action: async () => ({ status: "idle" as const }),
    defaultPolicyJson: JSON.stringify(samplePolicy, null, 2),
    defaultScopeType: "tenant",
    defaultScopeId: "logistics_hq",
    testIdPrefix: "access-request-scoped",
  },
};
