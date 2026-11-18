import type { Meta, StoryObj } from "@storybook/react";
import { RouteLoadingPage } from "./route-loading-page";

const meta: Meta<typeof RouteLoadingPage> = {
  title: "Feedback/RouteLoadingPage",
  component: RouteLoadingPage,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Shared loading component for Next.js route loading.tsx files. " +
          "Uses LoadingState with page variant for full-page shimmer skeleton.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof RouteLoadingPage>;

export const Default: Story = {};
