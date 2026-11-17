import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { Button } from "./button";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerBody,
  DrawerFooter
} from "./drawer";

const meta: Meta<typeof Drawer> = {
  title: "Feedback/Drawer",
  component: Drawer
};

export default meta;
type Story = StoryObj<typeof Drawer>;

export const Right: Story = {
  render: () => {
    const [open, setOpen] = React.useState(true);
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Filter shipments</DrawerTitle>
            <DrawerDescription>
              Refine the data shown in the console table.
            </DrawerDescription>
          </DrawerHeader>
          <DrawerBody>
            Use this panel to layer additional filters and save custom views.
          </DrawerBody>
          <DrawerFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button onClick={() => setOpen(false)}>Apply</Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    );
  }
};
