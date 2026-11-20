import type { Meta, StoryObj } from "@storybook/react";
import { AuthSignIn } from "./auth-sign-in";

const meta: Meta<typeof AuthSignIn> = {
  title: "Auth/AuthSignIn",
  component: AuthSignIn,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Sign-in form supporting magic link and password authentication methods. " +
          "Methods are configurable; defaults to platform-wide auth method settings.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof AuthSignIn>;

export const Default: Story = {
  args: {
    appLabel: "Console",
  },
};

export const MagicLinkOnly: Story = {
  args: {
    appLabel: "Console",
    methods: ["magic_link"],
  },
};

export const PasswordOnly: Story = {
  args: {
    appLabel: "Portal",
    methods: ["password"],
  },
};

export const BothMethods: Story = {
  args: {
    appLabel: "Console",
    methods: ["magic_link", "password"],
  },
};

export const WithBasePath: Story = {
  args: {
    appLabel: "Console",
    appBasePath: "/console",
    callbackPath: "/dashboard",
    testIdPrefix: "console-auth",
  },
};
