import type { Meta, StoryObj } from "@storybook/react";
import { JsonSchemaForm } from "./json-schema-form";

const meta: Meta<typeof JsonSchemaForm> = {
  title: "Forms/JsonSchemaForm",
  component: JsonSchemaForm,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Dynamic form generated from a JSON Schema definition. " +
          "Supports string, number, boolean, enum, array, and nested object fields. " +
          "Also supports resource_select widget for foreign key lookups.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof JsonSchemaForm>;

export const StringFields: Story = {
  args: {
    schema: {
      type: "object",
      properties: {
        name: { type: "string", title: "Name" },
        email: { type: "string", title: "Email", format: "email" },
        notes: { type: "string", title: "Notes" },
      },
      required: ["name", "email"],
    },
    value: { name: "", email: "", notes: "" },
    onChange: () => {},
  },
};

export const MixedTypes: Story = {
  args: {
    schema: {
      type: "object",
      properties: {
        label: { type: "string", title: "Label" },
        count: { type: "number", title: "Count" },
        enabled: { type: "boolean", title: "Enabled" },
        priority: {
          type: "string",
          title: "Priority",
          enum: ["low", "medium", "high"],
        },
      },
    },
    value: { label: "Test", count: 5, enabled: true, priority: "medium" },
    onChange: () => {},
  },
};

export const WithArrayField: Story = {
  args: {
    schema: {
      type: "object",
      properties: {
        tags: {
          type: "array",
          title: "Tags",
          items: { type: "string" },
        },
        name: { type: "string", title: "Name" },
      },
    },
    value: { tags: ["express", "fragile"], name: "Package" },
    onChange: () => {},
  },
};

export const Disabled: Story = {
  args: {
    schema: {
      type: "object",
      properties: {
        field1: { type: "string", title: "Read-only field" },
        field2: { type: "number", title: "Locked count" },
      },
    },
    value: { field1: "Cannot edit", field2: 42 },
    onChange: () => {},
    disabled: true,
  },
};

export const EmptySchema: Story = {
  args: {
    schema: null,
    value: {},
    onChange: () => {},
  },
};
