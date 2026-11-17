import type { Meta, StoryObj } from "@storybook/react";
import { ThemeProvider } from "./theme";
import { ThemeToggle } from "./theme-toggle";

const meta: Meta<typeof ThemeToggle> = {
  title: "Layout/ThemeToggle",
  component: ThemeToggle
};

export default meta;
type Story = StoryObj<typeof ThemeToggle>;

export const Default: Story = {
  render: () => (
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>
  )
};
