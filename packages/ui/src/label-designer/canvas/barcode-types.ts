export type BarcodeTypeConfig = {
  encoder: string;
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
    validate: /^[\x20-\x7E]{1,80}$/,
    defaultWidth: 180,
    defaultHeight: 60,
  },
  qr: {
    encoder: "qrcode",
    label: "QR Code",
    validate: /^.{1,2953}$/s,
    is2D: true,
    defaultWidth: 72,
    defaultHeight: 72,
  },
  ean13: {
    encoder: "ean13",
    label: "EAN-13",
    validate: /^\d{12,13}$/,
    defaultWidth: 180,
    defaultHeight: 60,
  },
  upca: {
    encoder: "upca",
    label: "UPC-A",
    validate: /^\d{11,12}$/,
    defaultWidth: 180,
    defaultHeight: 60,
  },
  code39: {
    encoder: "code39",
    label: "Code 39",
    validate: /^[A-Z0-9\-. $/+%]{1,43}$/,
    defaultWidth: 180,
    defaultHeight: 60,
  },
  pdf417: {
    encoder: "pdf417",
    label: "PDF417",
    validate: /^.{1,1850}$/s,
    is2D: true,
    defaultWidth: 180,
    defaultHeight: 60,
  },
  datamatrix: {
    encoder: "datamatrix",
    label: "DataMatrix",
    validate: /^.{1,2335}$/s,
    is2D: true,
    defaultWidth: 72,
    defaultHeight: 72,
  },
};

export function getBarcodeConfig(barcodeType: string): BarcodeTypeConfig | undefined {
  return BARCODE_REGISTRY[barcodeType.toLowerCase()];
}

export function validateBarcodeData(barcodeType: string, data: string): boolean {
  const config = getBarcodeConfig(barcodeType);
  if (!config) return false;
  return config.validate.test(data);
}
