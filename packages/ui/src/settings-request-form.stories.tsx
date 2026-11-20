import type { Meta, StoryObj } from "@storybook/react";
import { SettingsRequestForm } from "./settings-request-form";

const meta: Meta<typeof SettingsRequestForm> = {
  title: "Domain/SettingsRequestForm",
  component: SettingsRequestForm,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Form for requesting settings changes with category selector, " +
          "scope type/ID, and JSON settings editor. Uses server actions.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SettingsRequestForm>;

export const Default: Story = {
  args: {
    action: async () => ({ status: "idle" as const }),
    categories: [
      { category: "mobile_visibility_policy", description: "Mobile app visibility", allowedScopes: ["tenant", "client"] },
      { category: "navigation_policy", description: "Navigation configuration", allowedScopes: ["tenant"] },
      { category: "map_policy", description: "Map display settings", allowedScopes: ["tenant", "client", "sender"] },
    ],
    selectedCategory: "mobile_visibility_policy",
    selectedScopeType: "tenant",
    selectedScopeId: "",
    defaultSettingsJson: JSON.stringify({ show_dashboard: true, show_tracking: true }, null, 2),
    testIdPrefix: "settings-request",
  },
};
