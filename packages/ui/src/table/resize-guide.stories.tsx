import type { Meta, StoryObj } from "@storybook/react";
import { TableResizeGuide } from "./resize-guide";
import type { ResizeGuide } from "./resize-guide";

const meta: Meta<typeof TableResizeGuide> = {
  title: "Table/ResizeGuide",
  component: TableResizeGuide,
  decorators: [
    (Story) => (
      <div style={{ position: "relative", height: 200, border: "1px dashed #ccc" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof TableResizeGuide>;

const defaultGuide: ResizeGuide = { x: 200, width: 150 };

export const Default: Story = {
  args: {
    guide: defaultGuide,
  },
};

export const Hidden: Story = {
  args: {
    guide: null,
  },
};
