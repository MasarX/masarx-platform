import type { Meta, StoryObj } from "@storybook/react";
import { BlockCatalogSidebar } from "./block-catalog-sidebar";

const sampleFields = [
  { path: "shipment.tracking_number", label: "Tracking Number", label_ar: "\u0631\u0642\u0645 \u0627\u0644\u062a\u062a\u0628\u0639", type: "string" },
  { path: "shipment.recipient_name", label: "Recipient Name", type: "string" },
  { path: "shipment.recipient_address", label: "Recipient Address", type: "string" },
  { path: "shipment.sender_name", label: "Sender Name", type: "string" },
  { path: "shipment.weight_kg", label: "Weight (kg)", type: "number" },
  { path: "shipment.cod_amount", label: "COD Amount", type: "number" },
];

const sampleAssets = [
  { name: "company_logo.png", path: "org/company_logo.png" },
  { name: "barcode_frame.svg", path: "org/barcode_frame.svg" },
];

const meta: Meta<typeof BlockCatalogSidebar> = {
  title: "Label Designer/BlockCatalogSidebar",
  component: BlockCatalogSidebar,
  args: {
    fieldCatalog: sampleFields,
    assets: sampleAssets,
    onAddBlock: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof BlockCatalogSidebar>;

export const Default: Story = {};

export const EmptyFields: Story = {
  args: { fieldCatalog: [], assets: [] },
};

export const WithSearch: Story = {
  args: { fieldCatalog: sampleFields, assets: [] },
};
