import type { Meta, StoryObj } from "@storybook/react";
import { PreviewPanel } from "./preview-panel";

const meta: Meta<typeof PreviewPanel> = {
  title: "Label Designer/PreviewPanel",
  component: PreviewPanel,
  args: {
    prefix: "ld",
    isBusy: false,
    busyAction: null,
    shipments: [
      { id: "ship-001", label: "TRK-20250615-001 \u2022 pending" },
      { id: "ship-002", label: "TRK-20250615-002 \u2022 delivered" },
      { id: "ship-003", label: "TRK-20250615-003 \u2022 in_transit" },
    ],
    selectedShipmentId: "ship-001",
    shipmentBoxes: [
      { id: "box-1", label: "Box 1 \u2022 BC001" },
      { id: "box-2", label: "Box 2 \u2022 BC002" },
    ],
    selectedShipmentBoxId: "",
    selectedDraftId: "draft-001",
    samplePayloadJson: JSON.stringify({
      shipment: {
        tracking_number: "TRK-20250615-001",
        recipient_name: "Ahmed Ali",
        recipient_address: "123 Main Street, Riyadh",
        sender_name: "Acme Corp",
        weight_kg: 2.5,
      },
    }, null, 2),
    previewResponseJson: "",
    onShipmentChange: () => {},
    onShipmentBoxChange: () => {},
    onLoadSamplePayload: () => {},
    onPreviewDraft: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof PreviewPanel>;

export const Default: Story = {};

export const Loading: Story = {
  args: { isBusy: true, busyAction: "sample-payload" },
};

export const NoDraftSelected: Story = {
  args: { selectedDraftId: "" },
};
