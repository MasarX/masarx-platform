/** Shared authoring/rendering bounds; the encoder also validates format and capacity. */
export const BARCODE_MAX_CHARS: Record<string, number> = {
  code128: 80, qr: 2953, ean13: 13, upca: 12, code39: 43, pdf417: 1850, datamatrix: 2335,
};

export function normalizeBarcodeType(value: string): string {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, string> = { "ean-13": "ean13", "upc-a": "upca", qrcode: "qr", qr_code: "qr", "code-128": "code128", "code-39": "code39", "data-matrix": "datamatrix" };
  return Object.hasOwn(aliases, normalized) ? aliases[normalized]! : normalized;
}
