import { fitBlockToPage, placeAddedBlock, prepareAddedBlock } from "../../packages/ui/src/label-designer/canvas/block-geometry";
import { canonicalBarcodeType, encodeAdditionalBarcode, rotateBarcodePoint } from "../../supabase/functions/label-renderer/barcode";
import { getBarcodeConfig } from "../../packages/ui/src/label-designer/canvas/barcode-types";

// @ts-expect-error -- existing bwip types live under its browser/node export conditions.
import bwip from "bwip-js";
const page = { width_inch: 4, height_inch: 6 };

describe("label authoring geometry and renderer contract", () => {
  test("defaults new text/barcode/image without replacing explicit values", () => {
    expect(prepareAddedBlock({ type: "text", x: 0, y: 0, fallback: "", font_size: 9 }, page)).toMatchObject({ width: 150, height: 20, fallback: "", font_size: 9 });
    expect(prepareAddedBlock({ type: "barcode", x: 10, y: 10, barcode_type: "QR", human_readable: false }, page)).toMatchObject({ barcode_type: "qr", width: 72, height: 72, fallback: "TRACKING", human_readable: false });
    expect(prepareAddedBlock({ type: "image", x: 2, y: 3, width: 35, height: 17, asset_ref: "logo" }, page)).toMatchObject({ width: 35, height: 17, asset_ref: "logo" });
    expect(prepareAddedBlock({ type: "line", x: 0, y: 0, height: 0 }, page).height).toBe(0);
  });

  test("bounds additions, moves and oversized blocks on both axes", () => {
    expect(fitBlockToPage({ type: "text", x: 999, y: -9, width: 100, height: 50 }, page)).toMatchObject({ x: 188, y: 0, width: 100, height: 50 });
    expect(fitBlockToPage({ type: "image", x: 99, y: 99, width: 999, height: 999 }, page)).toMatchObject({ x: 0, y: 0, width: 288, height: 432 });
    const next = placeAddedBlock({ type: "text", x: 999, y: 5 }, [{ type: "text", x: 0, y: 420, height: 12 }], page);
    expect(next.x + next.width!).toBeLessThanOrEqual(288);
    expect(next.y + next.height!).toBeLessThanOrEqual(432);
  });

  test("bounds right/center anchors without inserting legacy dimensions or rewriting property edits", () => {
    const legacy = { type: "text" as const, x: 270, y: 100, align: "right" as const, value_path: "sender_phone" };
    expect(fitBlockToPage({ ...legacy, font_size: 14 }, page, legacy)).toEqual({ ...legacy, font_size: 14 });
    expect(fitBlockToPage({ ...legacy, x: 999 }, page, legacy)).toEqual({ ...legacy, x: 288 });
    expect(fitBlockToPage({ ...legacy, x: 276, width: 264 }, page)).toMatchObject({ x: 276, width: 264 });
    expect(fitBlockToPage({ ...legacy, x: 1, width: 264 }, page)).toMatchObject({ x: 264, width: 264 });
    expect(fitBlockToPage({ ...legacy, align: "center", x: 999, width: 264 }, page)).toMatchObject({ x: 156, width: 264 });
    expect(fitBlockToPage({ type: "line", x: 260, y: 400, width: 280, height: 420 }, page)).toEqual({ type: "line", x: 260, y: 400, width: 280, height: 420 });
  });

  test.each([
    ["left", "right", 10, 150], ["right", "left", 276, 138],
    ["left", "center", 10, 75], ["center", "left", 220, 138],
    ["center", "right", 75, 150], ["right", "center", 276, 213],
  ] as const)("bounds an alignment edit from %s to %s", (before, after, x, expected) => {
    const original = { type: "text" as const, x, y: 100, width: 150, align: before };
    expect(fitBlockToPage({ ...original, align: after }, page, original)).toEqual({ ...original, align: after, x: expected });
  });

  test("bounds legacy maximum dimensions on moves without adding width/height or changing unrelated properties", () => {
    const legacy = { type: "text" as const, x: 270, y: 100, max_width: 100, max_height: 30, align: "right" as const };
    expect(fitBlockToPage({ ...legacy, x: 10, y: 430 }, page, legacy)).toEqual({ ...legacy, x: 100, y: 402 });
    expect(fitBlockToPage({ ...legacy, align: "center", x: 0 }, page, legacy)).toEqual({ ...legacy, align: "center", x: 50 });
    expect(fitBlockToPage({ ...legacy, align: "left", x: 280 }, page, legacy)).toEqual({ ...legacy, align: "left", x: 188 });
    expect(fitBlockToPage({ ...legacy, width: 20, height: 10, x: 10, y: 430 }, page, legacy)).toEqual({ ...legacy, width: 20, height: 10, x: 20, y: 422 });
    const fontEdit = { ...legacy, font_size: 14 };
    expect(fitBlockToPage(fontEdit, page, legacy)).toBe(fontEdit);
  });

  test("changes to active maximum dimensions also recheck geometry", () => {
    const legacy = { type: "text" as const, x: 30, y: 420, max_width: 20, max_height: 10, align: "right" as const };
    expect(fitBlockToPage({ ...legacy, max_width: 100, max_height: 40 }, page, legacy)).toEqual({ ...legacy, x: 100, y: 392, max_width: 100, max_height: 40 });
  });

  test("places an addition after existing content when room is available", () => {
    expect(placeAddedBlock({ type: "text", x: 10, y: 10 }, [{ type: "text", x: 10, y: 10, height: 20 }], page).y).toBe(38);
  });

  test("keeps sub-inch page bounds and rotates barcode modules around the authored origin", () => {
    expect(fitBlockToPage({ type: "image", x: 90, y: 90, width: 80, height: 80 }, { width_inch: 0.5, height_inch: 0.5 })).toMatchObject({ width: 36, height: 36, x: 0, y: 0 });
    const point = rotateBarcodePoint({ x: 20, y: 30 }, { x: 10, y: 10 }, 90);
    expect(point.x).toBeCloseTo(-10);
    expect(point.y).toBeCloseTo(20);
    expect(rotateBarcodePoint({ x: 20, y: 30 }, { x: 10, y: 10 })).toEqual({ x: 20, y: 30 });
  });

  test.each([
    ["EAN13", "590123412345", "ean13"], ["ean-13", "590123412345", "ean13"],
    ["UPC-A", "01234567890", "upca"], ["code-39", "TRACKING", "code39"],
    ["PDF417", "TRACKING", "pdf417"], ["data-matrix", "TRACKING", "datamatrix"],
  ])("uses the real %s encoder, never a Code128 substitute", (type, value, expected) => {
    const raw = jest.fn(bwip.raw as Parameters<typeof encodeAdditionalBarcode>[0]);
    const result = encodeAdditionalBarcode(raw, type, value);
    expect(raw).toHaveBeenCalledWith({ bcid: expected, text: value });
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.rectangles.length).toBeGreaterThan(0);
    if (expected === "ean13" || expected === "upca") expect(result.width).toBe(95);
    if (expected === "pdf417") expect(result.rectangles.some((rect) => rect.height === 3)).toBe(true);
    expect(getBarcodeConfig(type)?.encoder).toBe(expected);
    result.rectangles.forEach((rect) => {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(result.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(result.height);
    });
  });

  test.each(["code128", "CODE-128", "QR", "qr_code", "qrcode"])("preserves the existing %s renderer selection", (type) => {
    expect(["code128", "qr"]).toContain(canonicalBarcodeType(type));
    expect(() => encodeAdditionalBarcode(bwip.raw, type, "TRACKING")).toThrow("existing Code128/QR");
  });

  test("rejects unknown formats and invalid data rather than silently changing their symbology", () => {
    const raw = jest.fn(bwip.raw as Parameters<typeof encodeAdditionalBarcode>[0]);
    expect(() => encodeAdditionalBarcode(raw, "unknown", "TRACKING")).toThrow("Unsupported barcode");
    expect(raw).not.toHaveBeenCalled();
    expect(() => encodeAdditionalBarcode(raw, "ean13", "not digits")).toThrow();
    expect(prepareAddedBlock({ type: "barcode", x: 0, y: 0, barcode_type: "future-format" }, page).barcode_type).toBe("future-format");
    expect(getBarcodeConfig("constructor")).toBeUndefined();
    expect(() => canonicalBarcodeType("__proto__")).toThrow("Unsupported barcode");
  });
});
