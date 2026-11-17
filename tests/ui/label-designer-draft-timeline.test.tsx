import { render, screen, fireEvent } from "@testing-library/react";
import { DraftTimeline } from "../../packages/ui/src/label-designer/draft-timeline";

const drafts = [
  {
    id: "d-1",
    scope_type: "tenant" as const,
    scope_id: "org-1",
    label_type: "shipping",
    draft_name: "Draft Alpha",
    draft_value: {},
    status: "draft",
    updated_at: "2025-06-01T10:00:00Z",
    published_at: null,
  },
  {
    id: "d-2",
    scope_type: "tenant" as const,
    scope_id: "org-1",
    label_type: "shipping",
    draft_name: "Published Beta",
    draft_value: {},
    status: "published",
    updated_at: "2025-06-02T12:00:00Z",
    published_at: "2025-06-02T12:00:00Z",
  },
];

describe("DraftTimeline", () => {
  it("renders timeline items", () => {
    const onSelect = jest.fn();
    render(
      <DraftTimeline drafts={drafts} selectedDraftId="d-1" onSelect={onSelect} />,
    );
    expect(screen.getByText("Draft Alpha")).toBeInTheDocument();
    expect(screen.getByText("Published Beta")).toBeInTheDocument();
  });

  it("calls onSelect when item clicked", () => {
    const onSelect = jest.fn();
    render(
      <DraftTimeline drafts={drafts} selectedDraftId="" onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByText("Draft Alpha"));
    expect(onSelect).toHaveBeenCalledWith("d-1");
  });

  it("shows empty message when no drafts", () => {
    render(
      <DraftTimeline drafts={[]} selectedDraftId="" onSelect={jest.fn()} />,
    );
    expect(screen.getByTestId("draft-timeline-empty")).toBeInTheDocument();
  });

  it("shows status text per draft", () => {
    render(
      <DraftTimeline drafts={drafts} selectedDraftId="" onSelect={jest.fn()} />,
    );
    expect(screen.getByText("draft")).toBeInTheDocument();
    expect(screen.getByText("published")).toBeInTheDocument();
  });
});
