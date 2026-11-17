import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { TimePicker } from "./time-picker";

const meta: Meta<typeof TimePicker> = {
  title: "Forms/TimePicker",
  component: TimePicker
};

export default meta;
type Story = StoryObj<typeof TimePicker>;

export const Default: Story = {
  render: () => {
    const [value, setValue] = React.useState("09:00");
    return <TimePicker value={value} onChange={setValue} />;
  }
};

export const WithMinMax: Story = {
  render: () => {
    const [value, setValue] = React.useState("09:00");
    return (
      <TimePicker value={value} onChange={setValue} min="08:00" max="17:00" />
    );
  }
};

export const Disabled: Story = {
  render: () => {
    const [value, setValue] = React.useState("12:30");
    return <TimePicker value={value} onChange={setValue} disabled />;
  }
};

export const WithStep: Story = {
  render: () => {
    const [value, setValue] = React.useState("09:00");
    return <TimePicker value={value} onChange={setValue} step={900} />;
  }
};
