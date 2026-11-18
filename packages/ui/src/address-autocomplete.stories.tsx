import type { Meta, StoryObj } from "@storybook/react";
import { AddressAutocomplete } from "./address-autocomplete";

const meta: Meta<typeof AddressAutocomplete> = {
  title: "Forms/AddressAutocomplete",
  component: AddressAutocomplete,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Address autocomplete input with geocoding provider integration. " +
          "Wraps Combobox with debounced search and structured field population. " +
          "Falls back to manual entry when no suggestions are available.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof AddressAutocomplete>;

export const Default: Story = {
  args: {
    value: "",
    onChange: () => {},
    placeholder: "Start typing an address...",
  },
};

export const WithValue: Story = {
  args: {
    value: "King Fahd Road, Riyadh",
    onChange: () => {},
  },
};

export const WithMockSuggestions: Story = {
  args: {
    value: "",
    onChange: () => {},
    placeholder: "Search address...",
    fetchSuggestions: async (query: string) => {
      if (!query || query.length < 2) return [];
      return [
        {
          id: "1",
          displayText: `${query} Street, Riyadh, Saudi Arabia`,
          city: "Riyadh",
          country: "SA",
          latitude: 24.7136,
          longitude: 46.6753,
        },
        {
          id: "2",
          displayText: `${query} Avenue, Jeddah, Saudi Arabia`,
          city: "Jeddah",
          country: "SA",
          latitude: 21.4858,
          longitude: 39.1925,
        },
      ];
    },
  },
};

export const Disabled: Story = {
  args: {
    value: "King Abdullah Road",
    onChange: () => {},
    disabled: true,
  },
};

export const WithError: Story = {
  args: {
    value: "",
    onChange: () => {},
    invalid: true,
    errorMessage: "A valid delivery address is required.",
    placeholder: "Enter delivery address",
  },
};
