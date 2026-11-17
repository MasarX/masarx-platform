import type { Meta, StoryObj } from "@storybook/react";
import { AssetManager } from "./asset-manager";

const meta: Meta<typeof AssetManager> = {
  title: "Label Designer/AssetManager",
  component: AssetManager,
  args: {
    prefix: "ld",
    isBusy: false,
    canWrite: true,
    assets: [
      { name: "company_logo.png", path: "org-abc/company_logo.png" },
      { name: "barcode_frame.svg", path: "org-abc/barcode_frame.svg" },
      { name: "label_bg.jpg", path: "org-abc/label_bg.jpg" },
    ],
    assetsError: null,
    onUpload: () => {},
    onUploadFiles: () => {},
    onOpen: () => {},
    onDelete: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof AssetManager>;

export const Default: Story = {};

export const Empty: Story = {
  args: { assets: [] },
};

export const WithError: Story = {
  args: { assetsError: "Failed to load assets. Check network connection." },
};

export const ReadOnly: Story = {
  args: { canWrite: false },
};
