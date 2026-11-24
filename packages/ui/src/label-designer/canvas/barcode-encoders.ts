import type { RenderOptions } from "bwip-js/browser";

function loadEncoders() {
  return import("bwip-js/browser").then(({ code128, code39, datamatrix, drawingSVG, ean13, pdf417, qrcode, upca }) => ({
    drawingSVG,
    encoders: { code128, code39, datamatrix, ean13, pdf417, qrcode, upca },
  }));
}

export type BarcodeEncoder = keyof Awaited<ReturnType<typeof loadEncoders>>["encoders"];
export type BarcodeRenderOptions = Omit<RenderOptions, "bcid">;

export async function loadBarcodeRenderer() {
  const { encoders, drawingSVG } = await loadEncoders();
  // Named encoders choose the symbology themselves. The upstream type still requires bcid.
  return (encoder: BarcodeEncoder, options: BarcodeRenderOptions): string =>
    encoders[encoder](options as RenderOptions, drawingSVG());
}
