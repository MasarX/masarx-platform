import { render, screen } from "@testing-library/react";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "../../packages/ui/src/drawer";
import { Dropdown, DropdownContent, DropdownItem, DropdownTrigger } from "../../packages/ui/src/dropdown";
import { Modal, ModalContent, ModalDescription, ModalTitle } from "../../packages/ui/src/modal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../packages/ui/src/tabs";
import { Toast, ToastDescription, ToastProvider, ToastTitle } from "../../packages/ui/src/toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../packages/ui/src/tooltip";

test("modal renders content when open", () => {
  render(
    <Modal open>
      <ModalContent>
        <ModalTitle>Modal title</ModalTitle>
        <ModalDescription>Modal description</ModalDescription>
        <p>Modal body</p>
      </ModalContent>
    </Modal>
  );
  expect(screen.getByText("Modal title")).toBeInTheDocument();
  expect(screen.getByText("Modal body")).toBeInTheDocument();
});

test("drawer renders content when open", () => {
  render(
    <Drawer open>
      <DrawerContent>
        <DrawerTitle>Drawer title</DrawerTitle>
        <DrawerDescription>Drawer description</DrawerDescription>
        <p>Drawer body</p>
      </DrawerContent>
    </Drawer>
  );
  expect(screen.getByText("Drawer title")).toBeInTheDocument();
  expect(screen.getByText("Drawer body")).toBeInTheDocument();
});

test("dropdown renders menu items", () => {
  render(
    <Dropdown open>
      <DropdownTrigger asChild>
        <button>Open</button>
      </DropdownTrigger>
      <DropdownContent>
        <DropdownItem>First</DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
  expect(screen.getByText("First")).toBeInTheDocument();
});

test("tabs render active content", () => {
  render(
    <Tabs defaultValue="alpha">
      <TabsList>
        <TabsTrigger value="alpha">Alpha</TabsTrigger>
        <TabsTrigger value="beta">Beta</TabsTrigger>
      </TabsList>
      <TabsContent value="alpha">Alpha content</TabsContent>
      <TabsContent value="beta">Beta content</TabsContent>
    </Tabs>
  );
  expect(screen.getByText("Alpha content")).toBeInTheDocument();
});

test("tooltip renders content when open", () => {
  render(
    <TooltipProvider>
      <Tooltip open>
        <TooltipTrigger asChild>
          <button>Info</button>
        </TooltipTrigger>
        <TooltipContent>Helpful tip</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
  expect(screen.getAllByText("Helpful tip").length).toBeGreaterThan(0);
});

test("toast renders content when open", () => {
  render(
    <ToastProvider>
      <Toast open>
        <ToastTitle>Saved</ToastTitle>
        <ToastDescription>Changes stored</ToastDescription>
      </Toast>
    </ToastProvider>
  );
  expect(screen.getByText("Saved")).toBeInTheDocument();
  expect(screen.getByText("Changes stored")).toBeInTheDocument();
});
