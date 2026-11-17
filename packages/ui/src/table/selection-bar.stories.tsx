import type { Meta, StoryObj } from "@storybook/react";
import { TableSelectionBar } from "./selection-bar";
import type { TranslateFn } from "./types";

const noop = () => {};

const mockT: TranslateFn = (key, values) => {
  if (values) return `${key} ${JSON.stringify(values)}`;
  return key;
};

const meta: Meta<typeof TableSelectionBar> = {
  title: "Table/SelectionBar",
  component: TableSelectionBar,
  args: {
    t: mockT,
    onClear: noop,
  },
};

export default meta;
type Story = StoryObj<typeof TableSelectionBar>;

export const Default: Story = {
  args: {
    selectedCount: 3,
    selectedIds: ["1", "2", "3"],
  },
};

export const Empty: Story = {
  args: {
    selectedCount: 0,
    selectedIds: [],
  },
};

export const WithBulkActions: Story = {
  args: {
    selectedCount: 2,
    selectedIds: ["1", "2"],
    renderBulkActions: (ids: string[]) => (
      <>
        <button type="button" onClick={() => {}}>
          Delete ({ids.length})
        </button>
        <button type="button" onClick={() => {}}>
          Archive
        </button>
      </>
    ),
  },
};
