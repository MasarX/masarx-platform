import type { Meta, StoryObj } from "@storybook/react";
import { RelatedResourceInlineDetail } from "./related-resource-inline-detail";

const meta: Meta<typeof RelatedResourceInlineDetail> = {
  title: "Resource/RelatedResourceInlineDetail",
  component: RelatedResourceInlineDetail,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Inline detail card for related resources. Shows column values " +
          "with copy-to-clipboard and optional inline editing when write " +
          "capability is present.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof RelatedResourceInlineDetail>;

const sampleColumns = [
  { key: "name", label: "Name", position: 1 },
  { key: "email", label: "Email", position: 2 },
  { key: "phone", label: "Phone", position: 3 },
  { key: "city", label: "City", position: 4 },
];

export const Default: Story = {
  args: {
    resourceKey: "customers",
    columns: sampleColumns,
    item: {
      id: "cust_001",
      name: "Example Retail",
      email: "contact@example.test",
      phone: "+1 202-555-0101",
      city: "Riyadh",
    },
    idKey: "id",
    baseHref: "/customers",
  },
};

export const WithCapabilities: Story = {
  args: {
    resourceKey: "customers",
    columns: sampleColumns,
    item: {
      id: "cust_002",
      name: "Example Distribution",
      email: "operations@example.test",
      phone: "+1 202-555-0102",
      city: "Jeddah",
    },
    idKey: "id",
    baseHref: "/customers",
    capabilities: ["customers:read", "customers:write"],
    capabilityWrite: "customers:write",
  },
};

export const NullItem: Story = {
  args: {
    resourceKey: "customers",
    columns: sampleColumns,
    item: null,
    idKey: "id",
    baseHref: "/customers",
  },
};
