import type { Meta, StoryObj } from "@storybook/react";
import { PageContainer } from "./page-container";

const meta: Meta<typeof PageContainer> = {
  title: "Layout/PageContainer",
  component: PageContainer
};

export default meta;
type Story = StoryObj<typeof PageContainer>;

export const FullWidth: Story = {
  render: () => (
    <PageContainer maxWidth="full">
      <div className="rounded-lg border border-dashed border-ui-border p-8 text-center text-sm text-ui-muted">
        Full-width container content
      </div>
    </PageContainer>
  )
};

export const LayoutWidth: Story = {
  render: () => (
    <PageContainer maxWidth="layout">
      <div className="rounded-lg border border-dashed border-ui-border p-8 text-center text-sm text-ui-muted">
        Layout-constrained container content
      </div>
    </PageContainer>
  )
};

export const WithCustomClass: Story = {
  render: () => (
    <PageContainer maxWidth="layout" className="bg-ui-surface p-4">
      <div className="rounded-lg border border-dashed border-ui-border p-8 text-center text-sm text-ui-muted">
        Container with custom background and padding
      </div>
    </PageContainer>
  )
};
