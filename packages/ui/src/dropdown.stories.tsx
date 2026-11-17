import type { Meta, StoryObj } from "@storybook/react";
import {
  Dropdown,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator
} from "./dropdown";
import { Button } from "./button";

const meta: Meta<typeof Dropdown> = {
  title: "Feedback/Dropdown",
  component: Dropdown
};

export default meta;
type Story = StoryObj<typeof Dropdown>;

export const Default: Story = {
  render: () => (
    <Dropdown>
      <DropdownTrigger asChild>
        <Button variant="ghost">Actions</Button>
      </DropdownTrigger>
      <DropdownContent>
        <DropdownLabel>Operations</DropdownLabel>
        <DropdownItem>Duplicate</DropdownItem>
        <DropdownItem>Export</DropdownItem>
        <DropdownSeparator />
        <DropdownItem>Archive</DropdownItem>
      </DropdownContent>
    </Dropdown>
  )
};
