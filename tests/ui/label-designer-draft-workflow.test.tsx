import { render, screen, fireEvent } from "@testing-library/react";
import { DraftWorkflow } from "../../packages/ui/src/label-designer/draft-workflow";

const mockDraft = {
  id: "draft-1",
  scope_type: "tenant" as const,
  scope_id: "org-1",
  label_type: "shipping",
  draft_name: "Test Draft",
  draft_value: { blocks: [] },
  status: "draft",
  updated_at: "2025-01-01",
  published_at: null,
};

const defaultProps = {
  prefix: "ld",
  canWrite: true,
  isBusy: false,
  busyAction: null as string | null,
  selectedScope: { scopeType: "tenant", scopeId: "org-1" },
  drafts: [mockDraft],
  selectedDraftId: "draft-1",
  draftName: "Test Draft",
  labelType: "shipping",
  labelTypeOptions: ["shipping", "return"],
  draftEditor: '{"blocks": []}',
  draftEditorError: null as string | null,
  onDraftSelection: jest.fn(),
  onDraftNameChange: jest.fn(),
  onLabelTypeChange: jest.fn(),
  onDraftEditorChange: jest.fn(),
  onCreateDraft: jest.fn(),
  onSaveDraft: jest.fn(),
  onValidateDraft: jest.fn(),
  onPublishDraft: jest.fn(),
};

describe("DraftWorkflow", () => {
  beforeEach(() => {
    Object.values(defaultProps).forEach((v) => {
      if (typeof v === "function") (v as jest.Mock).mockClear();
    });
  });

  it("renders draft select with options", () => {
    render(<DraftWorkflow {...defaultProps} />);
    const select = screen.getByTestId("ld-draft-select");
    expect(select).toBeInTheDocument();
  });

  it("renders draft name input", () => {
    render(<DraftWorkflow {...defaultProps} />);
    const input = screen.getByTestId("ld-draft-name");
    expect(input).toHaveValue("Test Draft");
  });

  it("renders label type select", () => {
    render(<DraftWorkflow {...defaultProps} />);
    const select = screen.getByTestId("ld-label-type");
    expect(select).toBeInTheDocument();
  });

  it("calls onDraftNameChange on input", () => {
    render(<DraftWorkflow {...defaultProps} />);
    const input = screen.getByTestId("ld-draft-name");
    fireEvent.change(input, { target: { value: "New Name" } });
    expect(defaultProps.onDraftNameChange).toHaveBeenCalledWith("New Name");
  });

  it("calls onCreateDraft when create button clicked", () => {
    render(<DraftWorkflow {...defaultProps} />);
    const btn = screen.getByTestId("ld-create-draft");
    fireEvent.click(btn);
    expect(defaultProps.onCreateDraft).toHaveBeenCalled();
  });

  it("shows busy text on save button", () => {
    render(<DraftWorkflow {...defaultProps} busyAction="save-draft" isBusy={true} />);
    const btn = screen.getByTestId("ld-save-draft");
    expect(btn.textContent).toMatch(/Saving|حفظ/i);
  });

  it("disables save when not a draft status", () => {
    const publishedDraft = { ...mockDraft, status: "published" };
    render(
      <DraftWorkflow {...defaultProps} drafts={[publishedDraft]} />,
    );
    const btn = screen.getByTestId("ld-save-draft");
    expect(btn).toBeDisabled();
  });

  it("switches between visual and code tabs", () => {
    render(<DraftWorkflow {...defaultProps} />);
    const codeTab = screen.getByTestId("ld-tab-code");
    fireEvent.click(codeTab);
    expect(screen.getByTestId("ld-draft-json")).toBeInTheDocument();
  });

  it("shows draft editor error when present", () => {
    render(
      <DraftWorkflow {...defaultProps} draftEditorError="JSON parse error" />,
    );
    expect(screen.getByTestId("ld-draft-json-error")).toHaveTextContent("JSON parse error");
  });
});
