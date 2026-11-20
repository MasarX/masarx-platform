import type { Meta, StoryObj } from "@storybook/react";
import { ResourceDetailNavigation } from "./resource-detail-navigation";

const meta: Meta<typeof ResourceDetailNavigation> = {
  title: "Resource/ResourceDetailNavigation",
  component: ResourceDetailNavigation,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Prev/next record navigation with keyboard shortcuts (Alt+Arrow). " +
          "Shows current position indicator (e.g. 3 of 25).",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ResourceDetailNavigation>;

export const Default: Story = {
  args: {
    prevHref: "/shipments/sh_002",
    nextHref: "/shipments/sh_004",
    currentIndex: 3,
    totalCount: 25,
    appBasePath: "/console",
  },
};

export const FirstRecord: Story = {
  args: {
    prevHref: null,
    nextHref: "/shipments/sh_002",
    currentIndex: 1,
    totalCount: 25,
    appBasePath: "/console",
  },
};

export const LastRecord: Story = {
  args: {
    prevHref: "/shipments/sh_024",
    nextHref: null,
    currentIndex: 25,
    totalCount: 25,
    appBasePath: "/console",
  },
};

export const SingleRecord: Story = {
  args: {
    prevHref: null,
    nextHref: null,
    currentIndex: 1,
    totalCount: 1,
    appBasePath: "/console",
  },
};
