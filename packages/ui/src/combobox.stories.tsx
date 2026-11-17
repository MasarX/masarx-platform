import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { Combobox } from "./combobox";

const meta: Meta<typeof Combobox> = {
  title: "Forms/Combobox",
  component: Combobox
};

export default meta;
type Story = StoryObj<typeof Combobox>;

export const SingleSelect: Story = {
  render: () => {
    const [value, setValue] = React.useState<string>("");
    return (
      <Combobox
        mode="single"
        options={[
          { value: "usd", label: "US Dollar" },
          { value: "eur", label: "Euro" },
          { value: "gbp", label: "British Pound" },
          { value: "jpy", label: "Japanese Yen" }
        ]}
        value={value}
        onChange={(v) => setValue(v as string)}
      />
    );
  }
};

export const MultiSelect: Story = {
  render: () => {
    const [value, setValue] = React.useState<string[]>(["shipping", "customs"]);
    return (
      <Combobox
        mode="multi"
        options={[
          { value: "shipping", label: "Shipping" },
          { value: "customs", label: "Customs" },
          { value: "warehouse", label: "Warehouse" },
          { value: "billing", label: "Billing" },
          { value: "tracking", label: "Tracking" }
        ]}
        value={value}
        onChange={(v) => setValue(v as string[])}
      />
    );
  }
};

export const WithPlaceholder: Story = {
  render: () => {
    const [value, setValue] = React.useState<string>("");
    return (
      <Combobox
        mode="single"
        options={[
          { value: "air", label: "Air Freight" },
          { value: "sea", label: "Sea Freight" },
          { value: "land", label: "Land Transport" }
        ]}
        value={value}
        onChange={(v) => setValue(v as string)}
        placeholder="Choose transport mode…"
      />
    );
  }
};

export const Disabled: Story = {
  render: () => {
    const [value, setValue] = React.useState<string>("sea");
    return (
      <Combobox
        mode="single"
        options={[
          { value: "air", label: "Air Freight" },
          { value: "sea", label: "Sea Freight" },
          { value: "land", label: "Land Transport" }
        ]}
        value={value}
        onChange={(v) => setValue(v as string)}
        disabled
      />
    );
  }
};

export const Loading: Story = {
  render: () => {
    const [value, setValue] = React.useState<string>("");
    return (
      <Combobox
        mode="single"
        options={[]}
        value={value}
        onChange={(v) => setValue(v as string)}
        loading
      />
    );
  }
};

export const AllowCreate: Story = {
  render: () => {
    const [value, setValue] = React.useState<string>("");
    return (
      <Combobox
        mode="single"
        options={[
          { value: "air", label: "Air Freight" },
          { value: "sea", label: "Sea Freight" }
        ]}
        value={value}
        onChange={(v) => setValue(v as string)}
        allowCreate
        onCreateOption={() => {}}
      />
    );
  }
};
