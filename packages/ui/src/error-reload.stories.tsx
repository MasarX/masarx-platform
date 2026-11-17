import type { Meta, StoryObj } from "@storybook/react";
import { ErrorReload } from "./error-reload";

const meta: Meta<typeof ErrorReload> = {
  title: "UI/States/ErrorReload",
  component: ErrorReload
};

export default meta;
type Story = StoryObj<typeof ErrorReload>;

export const Default: Story = {};
