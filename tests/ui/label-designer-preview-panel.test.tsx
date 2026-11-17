import { render, screen, fireEvent } from "@testing-library/react";
import { PreviewPanel } from "../../packages/ui/src/label-designer/preview-panel";

jest.mock("../../packages/ui/src/label-designer/pdf-preview", () => ({
  PdfPreview: ({ pdfBase64, testIdPrefix }: { pdfBase64: string; testIdPrefix: string }) => (
    <div data-testid={`${testIdPrefix}-mock`}>{pdfBase64 ? "PDF loaded" : "No PDF"}</div>
  ),
}));

const defaultProps = {
  prefix: "ld",
  isBusy: false,
  busyAction: null as string | null,
  shipments: [{ id: "ship-1", label: "TRK001 \u2022 pending" }],
  selectedShipmentId: "ship-1",
  shipmentBoxes: [{ id: "box-1", label: "Box 1" }],
  selectedShipmentBoxId: "",
  selectedDraftId: "draft-1",
  samplePayloadJson: '{"sample": true}',
  previewResponseJson: "",
  onShipmentChange: jest.fn(),
  onShipmentBoxChange: jest.fn(),
  onLoadSamplePayload: jest.fn(),
  onPreviewDraft: jest.fn(),
};

describe("PreviewPanel", () => {
  beforeEach(() => {
    defaultProps.onShipmentChange.mockClear();
    defaultProps.onShipmentBoxChange.mockClear();
    defaultProps.onLoadSamplePayload.mockClear();
    defaultProps.onPreviewDraft.mockClear();
  });

  it("renders shipment and box selects", () => {
    render(<PreviewPanel {...defaultProps} />);
    expect(screen.getByTestId("ld-shipment")).toBeInTheDocument();
    expect(screen.getByTestId("ld-shipment-box")).toBeInTheDocument();
  });

  it("calls onLoadSamplePayload on button click", () => {
    render(<PreviewPanel {...defaultProps} />);
    const btn = screen.getByTestId("ld-load-sample");
    fireEvent.click(btn);
    expect(defaultProps.onLoadSamplePayload).toHaveBeenCalled();
  });

  it("calls onPreviewDraft on preview button click", () => {
    render(<PreviewPanel {...defaultProps} />);
    const btn = screen.getByTestId("ld-preview");
    fireEvent.click(btn);
    expect(defaultProps.onPreviewDraft).toHaveBeenCalled();
  });

  it("shows busy text when loading sample", () => {
    render(<PreviewPanel {...defaultProps} busyAction="sample-payload" isBusy={true} />);
    const btn = screen.getByTestId("ld-load-sample");
    expect(btn.textContent).toMatch(/Loading|تحميل/i);
  });

  it("toggles debug JSON view", () => {
    render(<PreviewPanel {...defaultProps} />);
    expect(screen.queryByTestId("ld-preview-response")).not.toBeInTheDocument();
    const toggle = screen.getByTestId("ld-toggle-debug");
    fireEvent.click(toggle);
    expect(screen.getByTestId("ld-preview-response")).toBeInTheDocument();
  });

  it("disables preview when no draft selected", () => {
    render(<PreviewPanel {...defaultProps} selectedDraftId="" />);
    const btn = screen.getByTestId("ld-preview");
    expect(btn).toBeDisabled();
  });
});
