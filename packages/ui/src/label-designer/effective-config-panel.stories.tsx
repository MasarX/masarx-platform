import type { Meta, StoryObj } from "@storybook/react";
import { EffectiveConfigPanel } from "./effective-config-panel";

const meta: Meta<typeof EffectiveConfigPanel> = {
  title: "Label Designer/EffectiveConfigPanel",
  component: EffectiveConfigPanel,
  args: {
    prefix: "ld",
    effectiveDesignJson: JSON.stringify({
      templates: {
        shipping: {
          page: { width_inch: 4, height_inch: 6, dpi: 203 },
          blocks: [
            { type: "text", x: 20, y: 20, width: 200, height: 24 },
          ],
        },
      },
    }, null, 2),
    effectiveRenderPolicyJson: JSON.stringify({
      mode: "designer_preview",
      max_labels_per_request: 10,
      cache_ttl_seconds: 300,
    }, null, 2),
    effectivePrintProfileJson: JSON.stringify({
      paper_size: "4x6",
      orientation: "portrait",
      dpi: 203,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    }, null, 2),
    fieldCatalogJson: JSON.stringify({
      fields: [
        { path: "shipment.tracking_number", label: "Tracking Number", type: "string" },
        { path: "shipment.recipient_name", label: "Recipient Name", type: "string" },
      ],
    }, null, 2),
    mediaCatalogJson: JSON.stringify({
      media: [
        { key: "company_logo", type: "image/png", path: "org/company_logo.png" },
      ],
    }, null, 2),
  },
};

export default meta;
type Story = StoryObj<typeof EffectiveConfigPanel>;

export const Default: Story = {};
