import type { Meta, StoryObj } from "@storybook/react";
import { Section } from "./section";

const meta: Meta<typeof Section> = {
  title: "Layout/Section",
  component: Section
};

export default meta;
type Story = StoryObj<typeof Section>;

export const Default: Story = {
  render: () => (
    <Section>
      <div className="space-y-2">
        <div className="text-sm font-medium text-ui-ink">Section title</div>
        <div className="text-sm text-ui-muted">
          Use sections to group related controls or summaries.
        </div>
      </div>
    </Section>
  )
};

export const Collapsible: Story = {
  render: () => (
    <Section
      title="Collapsible overview"
      description="Toggle to show or hide the section body."
      collapsible
    >
      <div className="space-y-2 text-sm text-ui-muted">
        <p>Collapsible sections keep dense pages scannable.</p>
        <p>They also preserve space for high-priority content.</p>
      </div>
    </Section>
  )
};
