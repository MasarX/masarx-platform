import { screen, fireEvent } from "@testing-library/react";
import { PreviewPanel } from "../../packages/ui/src/label-designer/preview-panel";
import { renderWithIntl as render } from "./test-utils";
import arMessages from "../../packages/config/messages/ar.json";

let mockPdfFailure = false;

jest.mock("../../packages/ui/src/label-designer/pdf-preview", () => ({
  PdfPreview: ({ pdfBase64, testIdPrefix }: { pdfBase64: string; testIdPrefix: string }) => {
    if (mockPdfFailure) throw new Error("Synthetic PDF viewer failure");
    return <div data-testid={`${testIdPrefix}-mock`} data-pdf-base64={pdfBase64}>{pdfBase64 ? "PDF loaded" : "No PDF"}</div>;
  },
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
  const domMatrix = Object.getOwnPropertyDescriptor(window, "DOMMatrix");

  beforeEach(() => {
    Object.defineProperty(window, "DOMMatrix", { configurable: true, value: class {} });
    mockPdfFailure = false;
    defaultProps.onShipmentChange.mockClear();
    defaultProps.onShipmentBoxChange.mockClear();
    defaultProps.onLoadSamplePayload.mockClear();
    defaultProps.onPreviewDraft.mockClear();
  });

  afterEach(() => {
    if (domMatrix) Object.defineProperty(window, "DOMMatrix", domMatrix);
    else Reflect.deleteProperty(window, "DOMMatrix");
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

  it("discloses named preview details and retains the complete support response", async () => {
    const response = '{"pdf_base64":"synthetic-pdf","page_count":2,"renderer":"recorded-renderer"}';
    render(<PreviewPanel {...defaultProps} previewResponseJson={response} />);
    expect(screen.queryByTestId("ld-preview-response")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Show preview details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).not.toBeVisible();
    expect(screen.getByRole("textbox", { name: "Sample data" })).toHaveValue(defaultProps.samplePayloadJson);
    fireEvent.click(toggle);
    expect(toggle).toHaveAccessibleName("Hide preview details");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("textbox", { name: "Preview details" })).toHaveValue(response);
    expect(screen.getByRole("textbox", { name: "Preview details" })).toHaveAttribute("readonly");
    expect(await screen.findByTestId("ld-pdf-mock")).toHaveAttribute("data-pdf-base64", "synthetic-pdf");
    fireEvent.click(toggle);
    expect(screen.queryByRole("textbox", { name: "Preview details" })).toBeNull();
  });

  it("uses translated Arabic preview names and semantic field labels", () => {
    render(<PreviewPanel {...defaultProps} />, { locale: "ar", messages: arMessages });
    fireEvent.click(screen.getByRole("button", { name: "إظهار تفاصيل المعاينة" }));
    expect(screen.getByRole("button", { name: "إخفاء تفاصيل المعاينة" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("textbox", { name: "بيانات نموذجية" })).toHaveValue(defaultProps.samplePayloadJson);
    expect(screen.getByRole("textbox", { name: "تفاصيل المعاينة" })).toHaveValue("{}");
  });

  it("keeps a failed PDF viewer recoverable through the translated preview details", async () => {
    mockPdfFailure = true;
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<PreviewPanel {...defaultProps} previewResponseJson="synthetic unstructured response" />);
      expect(await screen.findByText("The PDF preview could not be opened. Check the preview details below.")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Show preview details" }));
      expect(screen.getByRole("textbox", { name: "Preview details" })).toHaveValue("synthetic unstructured response");
    } finally { consoleError.mockRestore(); }
  });

  it("disables preview when no draft selected", () => {
    render(<PreviewPanel {...defaultProps} selectedDraftId="" />);
    const btn = screen.getByTestId("ld-preview");
    expect(btn).toBeDisabled();
  });
});
