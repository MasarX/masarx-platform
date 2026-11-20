import type { Meta, StoryObj } from "@storybook/react";
import { RouteErrorPage } from "./route-error-page";

const meta: Meta<typeof RouteErrorPage> = {
  title: "Feedback/RouteErrorPage",
  component: RouteErrorPage,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Shared error boundary component for Next.js route error.tsx files. " +
          "Wraps ErrorState and provides a retry button via router.refresh().",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof RouteErrorPage>;

export const Default: Story = {
  args: {
    error: Object.assign(new Error("Failed to load resource data"), {
      digest: "ERR_001",
    }),
    reset: () => {},
  },
};

export const NetworkError: Story = {
  args: {
    error: Object.assign(new Error("Network request failed: ECONNREFUSED"), {
      digest: "ERR_NET_001",
    }),
    reset: () => {},
  },
};

export const AuthError: Story = {
  args: {
    error: Object.assign(new Error("Unauthorized: Invalid JWT token"), {
      digest: "ERR_AUTH_401",
    }),
    reset: () => {},
  },
};
