import type { Meta, StoryObj } from "@storybook/react";
import { ResourcePageSplitLayout } from "./resource-page-split-layout";

const meta: Meta<typeof ResourcePageSplitLayout> = {
  title: "Resource/ResourcePageSplitLayout",
  component: ResourcePageSplitLayout,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Resizable split panel layout with table on the left and detail on the right. " +
          "Supports draggable divider, persisted width in localStorage, and responsive bounds.",
      },
    },
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof ResourcePageSplitLayout>;

const MockTable = (
  <div className="h-full min-h-[400px] p-4 border border-ui-border/40 rounded-lg bg-ui-surface">
    <p className="text-sm font-medium">Table Panel</p>
    <p className="mt-1 text-xs text-ui-muted">Resource table content goes here.</p>
  </div>
);

const MockDetail = (
  <div className="h-full min-h-[400px] p-4 border border-ui-border/40 rounded-lg bg-ui-highlight">
    <p className="text-sm font-medium">Detail Panel</p>
    <p className="mt-1 text-xs text-ui-muted">Record detail content goes here.</p>
  </div>
);

export const Enabled: Story = {
  args: {
    enabled: true,
    storageKey: "storybook-split-layout",
    table: MockTable,
    detail: MockDetail,
  },
};

export const Disabled: Story = {
  args: {
    enabled: false,
    storageKey: "storybook-split-layout-off",
    table: MockTable,
    detail: MockDetail,
  },
};

export const CustomWidth: Story = {
  args: {
    enabled: true,
    storageKey: "storybook-split-custom",
    defaultDetailWidth: 500,
    minDetailWidth: 300,
    maxDetailWidth: 800,
    table: MockTable,
    detail: MockDetail,
  },
};
