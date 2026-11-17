import type { Meta, StoryObj } from "@storybook/react";
import { DraftTimeline } from "./draft-timeline";

const meta: Meta<typeof DraftTimeline> = {
  title: "Label Designer/DraftTimeline",
  component: DraftTimeline,
  args: {
    drafts: [
      {
        id: "d-001", scope_type: "tenant", scope_id: "org-1", label_type: "shipping",
        draft_name: "Standard Label v3", draft_value: {}, status: "published",
        updated_at: "2025-06-15T14:30:00Z", published_at: "2025-06-15T14:30:00Z",
      },
      {
        id: "d-002", scope_type: "tenant", scope_id: "org-1", label_type: "shipping",
        draft_name: "Standard Label v2", draft_value: {}, status: "validated",
        updated_at: "2025-06-14T11:00:00Z", published_at: null,
      },
      {
        id: "d-003", scope_type: "tenant", scope_id: "org-1", label_type: "shipping",
        draft_name: "Standard Label v1", draft_value: {}, status: "draft",
        updated_at: "2025-06-13T09:00:00Z", published_at: null,
      },
      {
        id: "d-004", scope_type: "tenant", scope_id: "org-1", label_type: "return",
        draft_name: "Return Label Draft", draft_value: {}, status: "draft",
        updated_at: "2025-06-12T16:00:00Z", published_at: null,
      },
    ],
    selectedDraftId: "d-001",
    onSelect: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof DraftTimeline>;

export const Default: Story = {};

export const Empty: Story = {
  args: { drafts: [] },
};
