/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, act, waitFor } from "@testing-library/react";

const mockEncoders = {
  code128: jest.fn(),
  code39: jest.fn(),
  datamatrix: jest.fn(),
  ean13: jest.fn(),
  pdf417: jest.fn(),
  qrcode: jest.fn(),
  upca: jest.fn(),
};
const mockDrawing = Symbol("SVG drawing");
jest.mock("bwip-js/browser", () => ({
  ...mockEncoders,
  drawingSVG: () => mockDrawing,
}));

import { CanvasBarcodeBlock } from "../../packages/ui/src/label-designer/canvas/canvas-barcode-block";
import type { TemplateBlock } from "../../packages/ui/src/label-designer/canvas/canvas-types";

const defaultProps = { x: 10, y: 10, width: 180, height: 60, scale: 1 };
function barcode(block: TemplateBlock) {
  return <svg><CanvasBarcodeBlock block={block} {...defaultProps} /></svg>;
}
function block(overrides: Partial<TemplateBlock> = {}): TemplateBlock {
  return { type: "barcode", x: 10, y: 10, width: 180, height: 60, barcode_type: "code128", ...overrides };
}
async function expectGenerated(container: HTMLElement) {
  await waitFor(() => {
    expect(container.querySelector("foreignObject")).not.toBeNull();
    expect(container.querySelector("foreignObject svg rect")).not.toBeNull();
  });
}

type Encoder = keyof typeof mockEncoders;

function expectOnlyEncoder(encoder: Encoder | undefined, calls = 1) {
  for (const [name, mock] of Object.entries(mockEncoders)) {
    expect(mock).toHaveBeenCalledTimes(name === encoder ? calls : 0);
  }
}

describe("CanvasBarcodeBlock", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockEncoders)) {
      mock.mockReset();
      mock.mockReturnValue('<svg><rect width="100" height="50" fill="black" /></svg>');
    }
  });

  it("renders loading before the encoder resolves, then generated SVG", async () => {
    const { container } = render(barcode(block({ fallback: "loading" })));
    expect(container.querySelector("text")?.textContent).toBe("Loading...");
    expect(container.querySelector("foreignObject")).toBeNull();
    await expectGenerated(container);
    expect(container.querySelector("text")).toBeNull();
    expect(container.querySelector("foreignObject")).toHaveAttribute("width", "180");
    expect(container.querySelector("foreignObject")).toHaveAttribute("height", "60");
  });
  it("rejects an unknown symbology without rendering a different barcode", () => {
    const block: TemplateBlock = { type: "barcode", x: 0, y: 0, barcode_type: "future-format", fallback: "INVALID-TYPE" };
    const { container } = render(<svg><CanvasBarcodeBlock block={block} {...defaultProps} /></svg>);
    expect(container.querySelector("text")).toHaveTextContent("Invalid");
    expectOnlyEncoder(undefined);
  });

  it("renders fallback while loading", () => {
    const block: TemplateBlock = {
      type: "barcode",
      x: 10, y: 10, width: 180, height: 60,
      barcode_type: "code128",
      fallback: "AAA-LOADING-TEST",
    };
    const { container } = render(
      <svg><CanvasBarcodeBlock block={block} {...defaultProps} /></svg>,
    );
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("names the encoded barcode once without exposing duplicate image descendants", async () => {
    const { container, getAllByRole, getByRole, rerender } = render(barcode(block({ fallback: "accessible-code128" })));
    await expectGenerated(container);
    expect(getAllByRole("img")).toHaveLength(1);
    expect(getByRole("img", { name: "Barcode block: Code 128" })).toContainElement(container.querySelector("foreignObject"));

    await act(async () => {
      rerender(barcode(block({ barcode_type: "qr", fallback: "accessible-qr" })));
    });
    await expectGenerated(container);
    expect(getAllByRole("img")).toHaveLength(1);
    expect(getByRole("img", { name: "Barcode block: QR Code" })).toBeInTheDocument();
  });

  it.each([
    ["QR", "qrcode", { barcode_type: "qr", fallback: "qr-data" }, { text: "qr-data" }],
    ["EAN-13", "ean13", { barcode_type: "ean13", fallback: "1234567890128" }, { text: "1234567890128" }],
    ["value_path", "code128", { value_path: "value-path-data" }, { text: "value-path-data" }],
    ["caption disabled", "code128", { fallback: "caption-disabled", human_readable: false }, { includetext: false }],
    ["caption default", "code128", { fallback: "caption-default" }, { includetext: true }],
    ["module width", "code128", { fallback: "module-width", module_width: 3 }, { width: 3 }],
    ["quiet zone", "code128", { fallback: "quiet-zone", quiet_zone_modules: 5 }, { paddingwidth: 5 }],
    ["QR correction", "qrcode", { barcode_type: "qr", fallback: "qr-correction", error_correction: "H" }, { eclevel: "H" }],
  ] as Array<[string, Encoder, Partial<TemplateBlock>, Record<string, unknown>]>)("passes %s options to the actual encoder", async (_name, encoder, overrides, expected) => {
    const { container } = render(barcode(block(overrides)));
    await expectGenerated(container);
    expectOnlyEncoder(encoder);
    expect(mockEncoders[encoder]).toHaveBeenCalledWith(expect.objectContaining(expected), mockDrawing);
  });

  it("omits unset dimensions and non-QR error correction from encoder options", async () => {
    const { container } = render(barcode(block({ fallback: "omitted-options", error_correction: "H" })));
    await expectGenerated(container);
    expectOnlyEncoder("code128");
    const options = mockEncoders.code128.mock.calls[0][0];
    expect(options).not.toHaveProperty("width");
    expect(options).not.toHaveProperty("paddingwidth");
    expect(options).not.toHaveProperty("eclevel");
  });

  it("shows Invalid without generated content when the encoder fails", async () => {
    mockEncoders.code128.mockImplementationOnce(() => { throw new Error("invalid barcode"); });
    const { container } = render(barcode(block({ fallback: "encoder-error" })));
    await waitFor(() => expect(container.querySelector("text")?.textContent).toBe("Invalid"));
    expectOnlyEncoder("code128");
    expect(container.querySelector("foreignObject")).toBeNull();
  });

  it("separates caption variants in the cache and reuses the normalized default", async () => {
    mockEncoders.code128.mockImplementation((options) => '<svg><text>' + String(options.includetext) + '</text></svg>');
    const original = block({ fallback: "caption-cache-regression", human_readable: true });
    const { container, rerender } = render(barcode(original));
    await waitFor(() => expect(container.querySelector("foreignObject text")?.textContent).toBe("true"));
    await act(async () => { rerender(barcode({ ...original, human_readable: false })); });
    await waitFor(() => expect(container.querySelector("foreignObject text")?.textContent).toBe("false"));
    expectOnlyEncoder("code128", 2);
    expect(mockEncoders.code128).toHaveBeenLastCalledWith(expect.objectContaining({ includetext: false }), mockDrawing);
    await act(async () => { rerender(barcode({ ...original, human_readable: undefined })); });
    expect(container.querySelector("foreignObject text")?.textContent).toBe("true");
    expectOnlyEncoder("code128", 2);
  });

  it("regenerates cached SVG when human-readable text changes and reuses matching output", async () => {
    const block: TemplateBlock = {
      type: "barcode",
      x: 10, y: 10, width: 180, height: 60,
      barcode_type: "code128",
      fallback: "HUMAN-TEXT-CACHE-REGRESSION",
      human_readable: true,
    };
    const { rerender } = render(
      <svg><CanvasBarcodeBlock block={block} {...defaultProps} /></svg>
    );
    await waitFor(() => {
      expect(mockEncoders.code128).toHaveBeenLastCalledWith(expect.objectContaining({ includetext: true }), mockDrawing);
    });

    rerender(
      <svg><CanvasBarcodeBlock block={{ ...block, human_readable: false }} {...defaultProps} /></svg>
    );
    await waitFor(() => {
      expect(mockEncoders.code128).toHaveBeenLastCalledWith(expect.objectContaining({ includetext: false }), mockDrawing);
    });
    expectOnlyEncoder("code128", 2);

    rerender(<svg><CanvasBarcodeBlock block={block} {...defaultProps} /></svg>);
    expectOnlyEncoder("code128", 2);
  });
});
