// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type { MobileV2LoaderScanEntry } from "../mobile-v2-loader-scan-screen";

export const MOBILE_V2_PREVIEW_LOADER_SCANS: ReadonlyArray<MobileV2LoaderScanEntry> =
  Object.freeze([
    { id: "ls-1", code: "DLX-LD-1001", action: "load", mode: "single", status: "ok", time: "11:14" },
    { id: "ls-2", code: "DLX-LD-1002", action: "load", mode: "single", status: "ok", time: "11:15" },
    { id: "ls-3", code: "DLX-LD-1003", action: "load", mode: "single", status: "duplicate", time: "11:15" },
    { id: "ls-4", code: "DLX-LD-1004", action: "load", mode: "single", status: "ok", time: "11:16" },
  ]);
