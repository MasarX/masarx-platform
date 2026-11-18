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

  it("preserves registry display labels while submitting the canonical code", () => {
    render(<DraftWorkflow {...defaultProps} labelTypeOptions={[
      { value: "shipping", label: "Shipment label" },
      { value: "return", label: "Return receipt" },
    ]} />);
    expect(screen.getByRole("option", { name: "Return receipt" })).toHaveValue("return");
    fireEvent.change(screen.getByTestId("ld-label-type"), { target: { value: "return" } });
    expect(defaultProps.onLabelTypeChange).toHaveBeenCalledWith("return");
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

  it("keeps draft name and JSON editor read-only without write capability", () => {
    render(<DraftWorkflow {...defaultProps} canWrite={false} />);
    const input = screen.getByTestId("ld-draft-name");
    expect(input).toBeDisabled();
    fireEvent.change(input, { target: { value: "Blocked Name" } });
    expect(defaultProps.onDraftNameChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("ld-tab-code"));
    const editor = screen.getByTestId("ld-draft-json");
    expect(editor).toBeDisabled();
    fireEvent.change(editor, { target: { value: "{\"blocks\":[{\"type\":\"text\"}]}" } });
    expect(defaultProps.onDraftEditorChange).not.toHaveBeenCalled();
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

  it("keeps save available for published drafts so operators can fork the next draft", () => {
    const publishedDraft = { ...mockDraft, status: "published" };
    render(
      <DraftWorkflow {...defaultProps} drafts={[publishedDraft]} />,
    );
    const btn = screen.getByTestId("ld-save-draft");
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(defaultProps.onSaveDraft).toHaveBeenCalled();
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
