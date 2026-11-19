import type { MobileV2LoaderSessionContext } from "./mobile-v2-loader-policy";

export interface MobileV2ActiveLoaderSession {
  readonly opsSessionId: string;
  readonly openedAt: string;
  readonly context: MobileV2LoaderSessionContext;
}

export function buildMobileV2StartLoaderSessionInput(input: {
  readonly deviceId: string;
  readonly openedAt: string;
  readonly context: MobileV2LoaderSessionContext;
}): Record<string, unknown> {
  return {
    session_type: "warehouse_scan",
    device_id: input.deviceId,
    opened_at: input.openedAt,
    session_code: `warehouse-scan-${input.deviceId}-${input.openedAt}`,
    idempotency_key: `warehouse-scan-${input.deviceId}-${input.openedAt}`,
    metadata: {
      bay: input.context.bay,
      wave_label: input.context.waveLabel,
      route_label: input.context.routeLabel,
      cut_off: input.context.cutOff,
      source: "mobile_v2_loader_session",
      mobile_v2_role: "loader",
    },
  };
}
