import type { Meta, StoryObj } from "@storybook/react";
import { KeyboardShortcutsModal } from "./keyboard-shortcuts-modal";

const meta: Meta<typeof KeyboardShortcutsModal> = {
  title: "Label Designer/KeyboardShortcutsModal",
  component: KeyboardShortcutsModal,
  args: {
    open: true,
    onClose: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof KeyboardShortcutsModal>;

export const Open: Story = {};

export const Closed: Story = {
  args: { open: false },
};
