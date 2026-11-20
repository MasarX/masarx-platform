import type { Meta, StoryObj } from "@storybook/react";
import { TableBodySkeleton } from "./table-body-skeleton";

const meta: Meta<typeof TableBodySkeleton> = {
  title: "Resource/TableBodySkeleton",
  component: TableBodySkeleton,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Skeleton overlay for table bodies during data fetching. " +
          "Shows shimmer rows that match typical table row heights.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof TableBodySkeleton>;

export const Default: Story = {
  args: {
    rows: 5,
    columns: 4,
  },
};

export const WideTable: Story = {
  args: {
    rows: 8,
    columns: 7,
  },
};

export const Compact: Story = {
  args: {
    rows: 3,
    columns: 2,
  },
};
