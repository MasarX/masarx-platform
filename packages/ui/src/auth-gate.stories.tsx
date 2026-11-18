import type { Meta, StoryObj } from "@storybook/react";
import { AuthGate } from "./auth-gate";

const meta: Meta<typeof AuthGate> = {
  title: "Auth/AuthGate",
  component: AuthGate,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Wraps page content with authentication gating. " +
          "Shows sign-in form when auth errors are detected, " +
          "renders children when authenticated.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof AuthGate>;

export const Authenticated: Story = {
  args: {
    appLabel: "Console",
    testIdPrefix: "console",
    children: (
      <div className="p-6">
        <h2 className="text-lg font-semibold">Authenticated Content</h2>
        <p className="mt-2 text-sm text-ui-muted">
          This content is visible when the user is authenticated.
        </p>
      </div>
    ),
  },
};

export const WithAuthError: Story = {
  args: {
    appLabel: "Console",
    testIdPrefix: "console",
    contextError: new Error("Unauthorized: Invalid JWT"),
    children: <div>This should not be visible.</div>,
  },
};

export const ForceAuth: Story = {
  args: {
    appLabel: "Portal",
    testIdPrefix: "portal",
    forceAuth: true,
    children: <div>Content behind forced auth.</div>,
  },
};
