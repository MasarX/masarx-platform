import { BARCODE_MAX_CHARS, normalizeBarcodeType } from "../_shared/label-barcodes.ts";
export { BARCODE_MAX_CHARS };

type RawSymbol = {
  sbs?: number[]; bhs?: number[]; bbs?: number[];
  pixs?: number[]; pixx?: number; pixy?: number;
};
type RawEncoder = (options: { bcid: string; text: string }) => RawSymbol[];
type Rectangle = { x: number; y: number; width: number; height: number };

export function rotateBarcodePoint(point: { x: number; y: number }, origin: { x: number; y: number }, rotation = 0) {
  const radians = rotation * Math.PI / 180;
  const dx = point.x - origin.x, dy = point.y - origin.y;
  return { x: origin.x + dx * Math.cos(radians) - dy * Math.sin(radians), y: origin.y + dx * Math.sin(radians) + dy * Math.cos(radians) };
}
export function canonicalBarcodeType(value: string): string {
  const type = normalizeBarcodeType(value);
  if (!Object.hasOwn(BARCODE_MAX_CHARS, type)) {
    throw new Error(`Unsupported barcode type: ${value}`);
  }
  return type;
}

/** Use the existing bwip encoder, not a Code128 fallback, for the other advertised formats. */
export function encodeAdditionalBarcode(raw: RawEncoder, type: string, text: string) {
  const canonical = canonicalBarcodeType(type);
  if (canonical === "code128" || canonical === "qr") throw new Error("Use the existing Code128/QR renderer.");
  const symbols = raw({ bcid: canonical, text });
  if (symbols.length !== 1) throw new Error("Expected one barcode symbol.");
  const symbol = symbols[0]!;
  // bwip accepts the payload without its EAN/UPC check digit and adds that digit to the bars.
  let humanReadableText = text;
  if ((canonical === "ean13" && text.length === 12) || (canonical === "upca" && text.length === 11)) {
    const sum = [...text].reverse().reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 3 : 1), 0);
    humanReadableText += (10 - sum % 10) % 10;
  }
  const rectangles: Rectangle[] = [];
  if (symbol.pixs && symbol.pixx && symbol.pixy) {
    const width = symbol.pixx, height = symbol.pixy;
    const rows = symbol.pixs.length / width;
    if (!Number.isInteger(rows) || rows <= 0 || height < rows) throw new Error("Invalid barcode matrix.");
    // bwip PDF417 returns logical rows with a 3-module row height, not repeated pixels.
    const rowHeight = height / rows;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < width; col++) {
        if (symbol.pixs[row * width + col]) rectangles.push({ x: col, y: height - (row + 1) * rowHeight, width: 1, height: rowHeight });
      }
    }
    return { width, height, rectangles, is2D: true, humanReadableText };
  }
  if (!symbol.sbs?.length) throw new Error("Invalid barcode bars.");
  let x = 0;
  symbol.sbs.forEach((width, index) => {
    if (index % 2 === 0) {
      const bar = index / 2;
      rectangles.push({ x, y: symbol.bbs?.[bar] ?? 0, width, height: symbol.bhs?.[bar] ?? 1 });
    }
    x += width;
  });
  return { width: x, height: 1, rectangles, is2D: false, humanReadableText };
}
