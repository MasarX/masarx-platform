import type { Meta, StoryObj } from "@storybook/react";
import { DraftWorkflow } from "./draft-workflow";

const sampleDraft = {
  id: "draft-001-abcd-efgh",
  scope_type: "tenant" as const,
  scope_id: "org-abc123",
  label_type: "shipping",
  draft_name: "Standard Shipping Label",
  draft_value: {
    templates: {
      shipping: {
        page: { width_inch: 4, height_inch: 6, dpi: 203 },
        blocks: [
          { type: "text", x: 20, y: 20, width: 200, height: 24, font_size: 16, value_path: "shipment.tracking_number", fallback: "TRK-000" },
          { type: "barcode", x: 20, y: 60, width: 200, height: 60, barcode_type: "code128", value_path: "shipment.tracking_number" },
          { type: "text", x: 20, y: 140, width: 150, height: 16, font_size: 10, value_path: "shipment.recipient_name", fallback: "Recipient" },
          { type: "text", x: 20, y: 160, width: 250, height: 16, font_size: 10, value_path: "shipment.recipient_address", fallback: "123 Main St" },
          { type: "image", x: 200, y: 10, width: 60, height: 30, asset_ref: "company_logo" },
          { type: "line", x: 10, y: 130, width: 268, height: 0, stroke_width: 1 },
          { type: "rect", x: 5, y: 5, width: 278, height: 420, stroke_width: 0.5 },
        ],
      },
    },
  },
  status: "draft",
  updated_at: "2025-06-15T10:30:00Z",
  published_at: null,
};

const meta: Meta<typeof DraftWorkflow> = {
  title: "Label Designer/DraftWorkflow",
  component: DraftWorkflow,
  args: {
    prefix: "ld",
    canWrite: true,
    isBusy: false,
    busyAction: null,
    selectedScope: { scopeType: "tenant", scopeId: "org-abc123" },
    drafts: [sampleDraft],
    selectedDraftId: "draft-001-abcd-efgh",
    draftName: "Standard Shipping Label",
    labelType: "shipping",
    labelTypeOptions: ["shipping", "return", "packing_slip"],
    draftEditor: JSON.stringify(sampleDraft.draft_value, null, 2),
    draftEditorError: null,
    fieldCatalogJson: JSON.stringify({
      fields: [
        { path: "shipment.tracking_number", label: "Tracking Number", label_ar: "\u0631\u0642\u0645 \u0627\u0644\u062a\u062a\u0628\u0639", type: "string" },
        { path: "shipment.recipient_name", label: "Recipient Name", label_ar: "\u0627\u0633\u0645 \u0627\u0644\u0645\u0633\u062a\u0644\u0645", type: "string" },
        { path: "shipment.recipient_address", label: "Recipient Address", type: "string" },
        { path: "shipment.sender_name", label: "Sender Name", type: "string" },
        { path: "shipment.weight_kg", label: "Weight (kg)", type: "number" },
        { path: "shipment.cod_amount", label: "COD Amount", type: "number" },
      ],
    }),
    assets: [
      { name: "company_logo.png", path: "org-abc123/company_logo.png" },
      { name: "barcode_frame.svg", path: "org-abc123/barcode_frame.svg" },
    ],
    onDraftSelection: () => {},
    onDraftNameChange: () => {},
    onLabelTypeChange: () => {},
    onDraftEditorChange: () => {},
    onCreateDraft: () => {},
    onSaveDraft: () => {},
    onValidateDraft: () => {},
    onPublishDraft: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof DraftWorkflow>;

export const VisualEditor: Story = {};

export const CodeEditor: Story = {
  render: (args) => {
    // Force code mode by rendering with the code tab selected
    return <DraftWorkflow {...args} />;
  },
};

export const ReadOnly: Story = {
  args: { canWrite: false },
};

export const Busy: Story = {
  args: { isBusy: true, busyAction: "save-draft" },
};

export const NoDrafts: Story = {
  args: {
    drafts: [],
    selectedDraftId: "",
    draftName: "",
    draftEditor: "{}",
  },
};

/** Full label with all block types including barcodes, locked blocks, and named layers. */
export const WithBlocks: Story = {
  args: {
    draftEditor: JSON.stringify({
      templates: {
        shipping: {
          page: { width_inch: 4, height_inch: 6, dpi: 203 },
          blocks: [
            { type: "text", x: 20, y: 20, width: 200, height: 24, font_size: 16, value_path: "shipment.tracking_number", fallback: "TRK-000", name: "Tracking #" },
            { type: "barcode", x: 20, y: 60, width: 200, height: 60, barcode_type: "code128", value_path: "shipment.tracking_number", fallback: "123456789", name: "Main Barcode" },
            { type: "barcode", x: 200, y: 300, width: 72, height: 72, barcode_type: "qr", fallback: "https://example.com/track", name: "QR Code" },
            { type: "barcode", x: 20, y: 300, width: 160, height: 50, barcode_type: "ean13", fallback: "590123412345", name: "EAN-13" },
            { type: "text", x: 20, y: 140, width: 150, height: 16, font_size: 10, value_path: "shipment.recipient_name", fallback: "John Doe" },
            { type: "text", x: 20, y: 160, width: 250, height: 16, font_size: 10, value_path: "shipment.recipient_address", fallback: "123 Main St, City" },
            { type: "image", x: 200, y: 10, width: 60, height: 30, asset_ref: "company_logo", name: "Logo" },
            { type: "line", x: 10, y: 130, width: 268, height: 0, stroke_width: 1 },
            { type: "rect", x: 5, y: 5, width: 278, height: 420, stroke_width: 0.5, locked: true, name: "Border" },
            { type: "text", x: 20, y: 200, width: 120, height: 16, font_size: 10, fallback: "Rotated", rotation: 15, color: "#2563eb" },
          ],
        },
      },
    }, null, 2),
  },
};
