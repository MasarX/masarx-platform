export type BarcodeQuality = "ok" | "at_risk" | "unscannable";

/**
 * Assess barcode quality based on module width in dots.
 * module_width_dots = (block_width_px / estimated_modules) * (dpi / 72)
 *
 * Thresholds:
 * - ok: >= 2 dots per module
 * - at_risk: >= 1 dot per module
 * - unscannable: < 1 dot per module
 */
export function assessBarcodeQuality(
  blockWidthPx: number,
  barcodeType: string,
  dpi: number = 203,
): BarcodeQuality {
  // Estimate number of modules per barcode type
  const moduleEstimates: Record<string, number> = {
    code128: 110,
    qr: 33,
    ean13: 95,
    upca: 95,
    code39: 130,
    pdf417: 90,
    datamatrix: 32,
  };

  const type = barcodeType.toLowerCase();
  const totalModules = moduleEstimates[type] || 100;
  const dotsPerModule = (blockWidthPx / totalModules) * (dpi / 72);

  if (dotsPerModule >= 2) return "ok";
  if (dotsPerModule >= 1) return "at_risk";
  return "unscannable";
}
