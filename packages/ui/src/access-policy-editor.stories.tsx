import type { Meta, StoryObj } from "@storybook/react";
import { AccessPolicyEditor } from "./access-policy-editor";

const meta: Meta<typeof AccessPolicyEditor> = {
  title: "Domain/AccessPolicyEditor",
  component: AccessPolicyEditor,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Full access policy editor with role catalog, capability catalog, " +
          "assignments panel, and deny overrides. Edits a JSON policy document.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof AccessPolicyEditor>;

const samplePolicy = {
  roles: [
    {
      key: "admin",
      label: "Administrator",
      description: "Full platform access",
      capabilities: ["shipments:read", "shipments:write", "orders:read", "orders:write", "settings:manage"],
    },
    {
      key: "operator",
      label: "Operator",
      description: "Day-to-day operations",
      capabilities: ["shipments:read", "shipments:write", "orders:read"],
    },
    {
      key: "viewer",
      label: "Viewer",
      description: "Read-only access",
      capabilities: ["shipments:read", "orders:read"],
    },
  ],
  assignments: [
    { role_key: "admin", scope_type: "tenant", scope_value: "*" },
    { role_key: "operator", scope_type: "tenant", scope_value: "logistics_hq" },
  ],
  deny: [],
};

export const Default: Story = {
  args: {
    policy: samplePolicy,
    onChange: () => {},
    testIdPrefix: "access-policy",
  },
};

export const EmptyPolicy: Story = {
  args: {
    policy: {},
    onChange: () => {},
    testIdPrefix: "access-policy-empty",
  },
};

export const WithDenyOverrides: Story = {
  args: {
    policy: {
      ...samplePolicy,
      deny: [
        { capability: "settings:manage", scope_type: "tenant", scope_value: "branch_a" },
      ],
    },
    onChange: () => {},
    testIdPrefix: "access-policy-deny",
  },
};
