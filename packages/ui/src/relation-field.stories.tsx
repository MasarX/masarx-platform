import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { RelationField } from "./relation-field";

const meta: Meta<typeof RelationField> = {
  title: "Forms/RelationField",
  component: RelationField
};

export default meta;
type Story = StoryObj<typeof RelationField>;

export const SingleSelect: Story = {
  render: () => {
    const [value, setValue] = React.useState<string>("");
    return (
      <RelationField
        mode="single"
        options={[
          { value: "org-1", label: "Acme Corp" },
          { value: "org-2", label: "Globex Inc" },
          { value: "org-3", label: "Initech Ltd" }
        ]}
        value={value}
        onChange={(v) => setValue(v as string)}
        placeholder="Link organisation…"
      />
    );
  }
};

export const MultiSelect: Story = {
  render: () => {
    const [value, setValue] = React.useState<string[]>([]);
    return (
      <RelationField
        mode="multi"
        options={[
          { value: "tag-1", label: "Urgent" },
          { value: "tag-2", label: "Follow-up" },
          { value: "tag-3", label: "Reviewed" }
        ]}
        value={value}
        onChange={(v) => setValue(v as string[])}
        placeholder="Add tags…"
      />
    );
  }
};

export const WithCreate: Story = {
  render: () => {
    const [value, setValue] = React.useState<string>("");
    return (
      <RelationField
        mode="single"
        options={[
          { value: "loc-1", label: "Jeddah" },
          { value: "loc-2", label: "Riyadh" }
        ]}
        value={value}
        onChange={(v) => setValue(v as string)}
        allowCreate
        onCreateOption={() => {}}
        placeholder="Select or create location…"
      />
    );
  }
};

export const Disabled: Story = {
  render: () => {
    const [value, setValue] = React.useState<string>("org-1");
    return (
      <RelationField
        mode="single"
        options={[
          { value: "org-1", label: "Acme Corp" },
          { value: "org-2", label: "Globex Inc" }
        ]}
        value={value}
        onChange={(v) => setValue(v as string)}
        disabled
      />
    );
  }
};
