import type { Meta, StoryObj } from "@storybook/react";
import { AppShell } from "./app-shell";

const meta: Meta<typeof AppShell> = {
  title: "Layout/AppShell",
  component: AppShell,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Full application shell with sidebar navigation, breadcrumbs, " +
          "keyboard shortcuts, and responsive mobile drawer. " +
          "Supports full-width and contained layout modes.",
      },
    },
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof AppShell>;

export const FullLayout: Story = {
  args: {
    appName: "Console",
    layout: "full",
    appKey: "console",
    children: (
      <div className="p-6">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="mt-2 text-sm text-ui-muted">
          Main application content area.
        </p>
      </div>
    ),
    sidebar: (
      <nav className="p-4 space-y-2 text-sm">
        <div className="font-medium">Dashboard</div>
        <div className="text-ui-muted">Shipments</div>
        <div className="text-ui-muted">Orders</div>
        <div className="text-ui-muted">Settings</div>
      </nav>
    ),
  },
};

export const ContainedLayout: Story = {
  args: {
    appName: "Portal",
    layout: "contained",
    appKey: "portal",
    children: (
      <div className="p-6">
        <h1 className="text-xl font-semibold">Tracking</h1>
        <p className="mt-2 text-sm text-ui-muted">
          Content with a max-width container.
        </p>
      </div>
    ),
  },
};

export const WithoutSidebar: Story = {
  args: {
    appName: "Console",
    appKey: "console",
    children: (
      <div className="p-6">
        <h1 className="text-xl font-semibold">Full width content</h1>
        <p className="mt-2 text-sm text-ui-muted">No sidebar rendered.</p>
      </div>
    ),
  },
};
