import type { Meta, StoryObj } from "@storybook/react";
import {
  CellBooleanDisplay,
  CellSelectTag,
  CellMultiSelect,
} from "./cell-renderers";

const booleanMeta: Meta<typeof CellBooleanDisplay> = {
  title: "Table/CellRenderers",
  component: CellBooleanDisplay,
};

export default booleanMeta;
type BooleanStory = StoryObj<typeof CellBooleanDisplay>;
type SelectTagStory = StoryObj<typeof CellSelectTag>;
type MultiSelectStory = StoryObj<typeof CellMultiSelect>;

export const BooleanTrue: BooleanStory = {
  args: {
    value: true,
  },
};

export const BooleanFalse: BooleanStory = {
  args: {
    value: false,
  },
};

export const SelectTag: SelectTagStory = {
  render: (args) => <CellSelectTag {...args} />,
  args: {
    value: "Active",
  },
};

export const MultiSelect: MultiSelectStory = {
  render: (args) => <CellMultiSelect {...args} />,
  args: {
    values: ["Frontend", "Backend", "DevOps"],
  },
};
