import type { Meta, StoryObj } from "@storybook/react";
import { CommandCatalogFilters } from "./command-catalog-filters";

const meta: Meta<typeof CommandCatalogFilters> = {
  title: "Resource/CommandCatalogFilters",
  component: CommandCatalogFilters
};

export default meta;
type Story = StoryObj<typeof CommandCatalogFilters>;

const defaultCategories = [
  { value: "", label: "All" },
  { value: "logistics", label: "Logistics" }
];

const defaultCapabilities = [
  { value: "", label: "All" },
  { value: "admin", label: "Admin" }
];

export const Default: Story = {
  args: {
    query: "",
    category: "",
    capability: "",
    access: "",
    categories: defaultCategories,
    capabilities: defaultCapabilities
  }
};

export const WithFilters: Story = {
  args: {
    query: "ship",
    category: "logistics",
    capability: "admin",
    access: "allowed",
    categories: defaultCategories,
    capabilities: defaultCapabilities
  }
};
