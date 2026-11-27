import { BARCODE_MAX_CHARS, normalizeBarcodeType } from "../../../../../supabase/functions/_shared/label-barcodes";
import type { BarcodeEncoder } from "./barcode-encoders";
export { normalizeBarcodeType };

export type BarcodeTypeConfig = {
  encoder: BarcodeEncoder;
  label: string;
  validate: RegExp;
  is2D?: boolean;
  defaultWidth?: number;
  defaultHeight?: number;
};

export const BARCODE_REGISTRY: Record<string, BarcodeTypeConfig> = {
  code128: {
    encoder: "code128",
    label: "Code 128",
    validate: new RegExp(`^[\\x20-\\x7E]{1,${BARCODE_MAX_CHARS.code128}}$`),
    defaultWidth: 180,
    defaultHeight: 60,
  },
  qr: {
    encoder: "qrcode",
    label: "QR Code",
    validate: new RegExp(`^.{1,${BARCODE_MAX_CHARS.qr}}$`, "s"),
    is2D: true,
    defaultWidth: 72,
    defaultHeight: 72,
  },
  ean13: {
    encoder: "ean13",
    label: "EAN-13",
    validate: new RegExp(`^\\d{12,${BARCODE_MAX_CHARS.ean13}}$`),
    defaultWidth: 180,
    defaultHeight: 60,
  },
  upca: {
    encoder: "upca",
    label: "UPC-A",
    validate: new RegExp(`^\\d{11,${BARCODE_MAX_CHARS.upca}}$`),
    defaultWidth: 180,
    defaultHeight: 60,
  },
  code39: {
    encoder: "code39",
    label: "Code 39",
    validate: new RegExp(`^[A-Z0-9\\-. $/+%]{1,${BARCODE_MAX_CHARS.code39}}$`),
    defaultWidth: 180,
    defaultHeight: 60,
  },
  pdf417: {
    encoder: "pdf417",
    label: "PDF417",
    validate: new RegExp(`^.{1,${BARCODE_MAX_CHARS.pdf417}}$`, "s"),
    is2D: true,
    defaultWidth: 180,
    defaultHeight: 60,
  },
  datamatrix: {
    encoder: "datamatrix",
    label: "DataMatrix",
    validate: new RegExp(`^.{1,${BARCODE_MAX_CHARS.datamatrix}}$`, "s"),
    is2D: true,
    defaultWidth: 72,
    defaultHeight: 72,
  },
};

export function getBarcodeConfig(barcodeType: string): BarcodeTypeConfig | undefined {
  const type = normalizeBarcodeType(barcodeType);
  return Object.hasOwn(BARCODE_REGISTRY, type) ? BARCODE_REGISTRY[type] : undefined;
}

export function validateBarcodeData(barcodeType: string, data: string): boolean {
  const config = getBarcodeConfig(barcodeType);
  if (!config) return false;
  return config.validate.test(data);
}
