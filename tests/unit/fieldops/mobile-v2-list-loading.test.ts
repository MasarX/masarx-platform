// Unit coverage for `isMobileV2ListLoading` — the SSOT loading-gate
// predicate behind every `MobileV2ListStateView` surface in PreviewBody.
//
// Engineering re-audit E10 (hidden mock): every list/detail surface
// derives `liveXxx = rpcHook.data ?? SAMPLE_FIXTURE`, and the loading
// gates were written as `rpc.isLoading && liveXxx.<field>.length === 0`.
// During the entire initial production fetch window `rpcHook.data` is
// `undefined`, so `liveXxx` is the NON-EMPTY preview fixture — the gate
// then evaluated false, the skeleton was suppressed, and the production
// native shell rendered the preview fixture (fake trips, fake wallet
// balances, fake EOR recon) as live data. The sharpest case let the EOR
// shift-end CTA submit the fixture recon into the real
// submit_fieldops_eod_recon_v1 decision_log write.
//
// The fix keys the gate off the query result itself (`data === undefined`)
// — never a screen-level fixture fallback. These tests pin that contract:
// a non-empty envelope value can never suppress a genuine first-load
// skeleton, and a settled envelope (real or fixture-as-data) renders
// without a skeleton flash.

import { isMobileV2ListLoading } from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";

describe("isMobileV2ListLoading — E10 loading-gate contract", () => {
  test("an in-flight query with no envelope yet shows the loading skeleton", () => {
    expect(isMobileV2ListLoading({ isLoading: true, data: undefined })).toBe(true);
  });

  test("a settled query (real envelope) does not show the skeleton", () => {
    expect(isMobileV2ListLoading({ isLoading: false, data: { rows: [] } })).toBe(false);
  });

  test("a non-empty fixture-shaped envelope as `data` never re-triggers the skeleton", () => {
    // The gate keys off `data === undefined`, NOT the envelope contents,
    // so a settled fixture-as-data (preview mode) or real data renders
    // immediately. This is the exact E10 defect inverted: a non-empty
    // value can never suppress — nor falsely trigger — the skeleton.
    expect(
      isMobileV2ListLoading({ isLoading: false, data: { drivers: [{ id: "x" }] } }),
    ).toBe(false);
  });

  test("a background refetch with data already present keeps data visible — no skeleton flash", () => {
    // Even if a caller passed `isLoading: true` while an envelope is
    // already present, the settled data must stay visible (the skeleton
    // is for the first load only, never a refetch).
    expect(
      isMobileV2ListLoading({ isLoading: true, data: { rows: [{ id: 1 }] } }),
    ).toBe(false);
  });

  test("an idle or errored query with no data does not show the skeleton", () => {
    // isError / idle states are surfaced by MobileV2ListStateView's own
    // error branch — the loading skeleton requires an in-flight query.
    expect(isMobileV2ListLoading({ isLoading: false, data: undefined })).toBe(false);
  });

  test("a settled query whose envelope is explicitly null does not show the skeleton", () => {
    // `null` is a settled (non-undefined) result — react-query has
    // produced a value, so the surface renders rather than skeletons.
    expect(isMobileV2ListLoading({ isLoading: false, data: null })).toBe(false);
  });
});
