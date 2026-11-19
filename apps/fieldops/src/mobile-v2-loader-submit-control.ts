import { shouldConfirmLoaderBulkSubmit, type MobileV2LoaderPolicy, type MobileV2LoaderScanMode } from "./mobile-v2-loader-policy";

export const MOBILE_V2_LOADER_STICKY_SUBMIT_TEST_ID = "mobile-v2-loader-submit-scans";
export const MOBILE_V2_LOADER_INLINE_SUBMIT_TEST_ID = "mobile-v2-loader-submit-scans-inline";

export interface MobileV2LoaderSubmitControlState {
  readonly allVisibleScansConfirmed: boolean;
  readonly disabled: boolean;
  readonly inlineVisible: boolean;
  readonly label: string;
  readonly pendingScanCount: number;
  readonly stickyTestId: string;
  readonly inlineTestId: string;
  readonly willConfirmBulk: boolean;
}

export function buildMobileV2LoaderSubmitControlState(input: {
  readonly policy: MobileV2LoaderPolicy;
  readonly mode: MobileV2LoaderScanMode;
  readonly scanCount: number;
  readonly confirmedScanCount: number;
}): MobileV2LoaderSubmitControlState {
  const pendingScanCount = Math.max(0, input.scanCount - input.confirmedScanCount);
  const allVisibleScansConfirmed = input.scanCount > 0 && pendingScanCount === 0;
  const willConfirmBulk = shouldConfirmLoaderBulkSubmit(input.policy, {
    scanCount: pendingScanCount,
    mode: input.mode,
  });
  const label = allVisibleScansConfirmed
    ? "Scans confirmed"
    : willConfirmBulk
      ? `Confirm ${pendingScanCount} scans`
      : `Submit ${pendingScanCount} scan${pendingScanCount === 1 ? "" : "s"}`;

  return {
    allVisibleScansConfirmed,
    disabled: pendingScanCount === 0,
    inlineVisible: pendingScanCount > 0,
    label,
    pendingScanCount,
    stickyTestId: MOBILE_V2_LOADER_STICKY_SUBMIT_TEST_ID,
    inlineTestId: MOBILE_V2_LOADER_INLINE_SUBMIT_TEST_ID,
    willConfirmBulk,
  };
}
