import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { DatePicker, DateRangePicker } from "./date-picker";

const meta: Meta<typeof DatePicker> = {
  title: "Forms/DatePicker",
  component: DatePicker
};

export default meta;
type Story = StoryObj<typeof DatePicker>;

export const Single: Story = {
  render: (args) => {
    const [value, setValue] = React.useState<Date | undefined>(new Date());
    return <DatePicker {...args} value={value} onChange={setValue} />;
  }
};

export const Range: Story = {
  render: () => {
    const [value, setValue] = React.useState<React.ComponentProps<typeof DateRangePicker>["value"]>({
      start: new Date(),
      end: new Date()
    });
    return <DateRangePicker value={value} onChange={setValue} />;
  }
};
