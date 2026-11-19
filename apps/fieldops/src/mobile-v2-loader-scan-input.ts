import type { MobileV2LoaderScanEntry } from "./mobile-v2-loader-scan-screen";
import type { MobileV2LoaderScanMode } from "./mobile-v2-loader-policy";

export type MobileV2LoaderBarcodeScanDraft =
  | { readonly kind: "empty" }
  | { readonly kind: "duplicate"; readonly code: string }
  | { readonly kind: "entry"; readonly entry: MobileV2LoaderScanEntry };

export function normalizeMobileV2LoaderBarcodeInput(value: string): string {
  return value.replace(/[\r\n\t]+/g, "").trim().toUpperCase();
}

export function createMobileV2LoaderBarcodeScanEntry(input: {
  readonly barcode: string;
  readonly existingScans: ReadonlyArray<MobileV2LoaderScanEntry>;
  readonly action: string;
  readonly mode: MobileV2LoaderScanMode;
  readonly id?: string;
  readonly time?: string;
}): MobileV2LoaderBarcodeScanDraft {
  const code = normalizeMobileV2LoaderBarcodeInput(input.barcode);
  if (code.length === 0) return { kind: "empty" };

  const duplicate = input.existingScans.some(
    (scan) => normalizeMobileV2LoaderBarcodeInput(scan.code) === code,
  );
  if (duplicate) return { kind: "duplicate", code };

  return {
    kind: "entry",
    entry: {
      id: input.id ?? `ls-barcode-${Date.now()}`,
      code,
      action: input.action,
      mode: input.mode,
      status: "ok",
      time: input.time ?? new Date().toTimeString().slice(0, 5),
    },
  };
}
