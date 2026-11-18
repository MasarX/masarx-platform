import type { Meta, StoryObj } from "@storybook/react";
import { KeyboardShortcutsHelp } from "./keyboard-shortcuts-help";

const meta: Meta<typeof KeyboardShortcutsHelp> = {
  title: "Navigation/KeyboardShortcutsHelp",
  component: KeyboardShortcutsHelp,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Modal dialog showing all registered keyboard shortcuts " +
          "grouped by context (General, Navigation, Resource, etc.).",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof KeyboardShortcutsHelp>;

const noop = () => {};

const sampleShortcuts = [
  { combo: "mod+k", action: noop, description: "Open command palette", group: "General" },
  { combo: "mod+/", action: noop, description: "Toggle keyboard shortcuts", group: "General" },
  { combo: "g d", action: noop, description: "Go to Dashboard", group: "Navigation" },
  { combo: "g s", action: noop, description: "Go to Shipments", group: "Navigation" },
  { combo: "g o", action: noop, description: "Go to Orders", group: "Navigation" },
  { combo: "n", action: noop, description: "New record", group: "Resource" },
  { combo: "e", action: noop, description: "Edit selected", group: "Resource" },
  { combo: "del", action: noop, description: "Delete selected", group: "Resource" },
  { combo: "mod+shift+f", action: noop, description: "Open filter builder", group: "Table" },
  { combo: "mod+shift+e", action: noop, description: "Export table", group: "Table" },
];

export const Default: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    shortcuts: sampleShortcuts,
  },
};

export const SingleGroup: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    shortcuts: [
      { combo: "mod+k", action: noop, description: "Open command palette", group: "General" },
      { combo: "mod+/", action: noop, description: "Toggle help", group: "General" },
      { combo: "?", action: noop, description: "Show shortcuts", group: "General" },
    ],
  },
};
