export type MobilePushPolicy = {
  enabled: boolean;
  registerOnStartup: boolean;
  requestPermission: boolean;
  emitLogEvents: boolean;
  provider: string;
  defaultChannelId: string;
  defaultChannelName: string;
};

export const DEFAULT_MOBILE_PUSH_POLICY: MobilePushPolicy = {
  enabled: false,
  registerOnStartup: true,
  requestPermission: true,
  emitLogEvents: true,
  provider: "expo",
  defaultChannelId: "fieldops-default",
  defaultChannelName: "Fieldops Alerts",
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function readString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

export function normalizeMobilePushPolicy(value: unknown): MobilePushPolicy {
  const input = asRecord(value);
  return {
    enabled: readBoolean(input.enabled, DEFAULT_MOBILE_PUSH_POLICY.enabled),
    registerOnStartup: readBoolean(
      input.register_on_startup,
      DEFAULT_MOBILE_PUSH_POLICY.registerOnStartup
    ),
    requestPermission: readBoolean(
      input.request_permission,
      DEFAULT_MOBILE_PUSH_POLICY.requestPermission
    ),
    emitLogEvents: readBoolean(input.emit_log_events, DEFAULT_MOBILE_PUSH_POLICY.emitLogEvents),
    provider: readString(input.provider, DEFAULT_MOBILE_PUSH_POLICY.provider).toLowerCase(),
    defaultChannelId: readString(
      input.default_channel_id,
      DEFAULT_MOBILE_PUSH_POLICY.defaultChannelId
    ),
    defaultChannelName: readString(
      input.default_channel_name,
      DEFAULT_MOBILE_PUSH_POLICY.defaultChannelName
    ),
  };
}

function readProjectId(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed ? trimmed : null;
}

export function resolveExpoProjectIdFromConstants(constants: unknown): string | null {
  const root = asRecord(constants);
  const easConfig = asRecord(root.easConfig);
  const easProjectId = readProjectId(easConfig.projectId);
  if (easProjectId) return easProjectId;

  const expoConfig = asRecord(root.expoConfig);
  const extra = asRecord(expoConfig.extra);
  const extraEas = asRecord(extra.eas);
  return readProjectId(extraEas.projectId);
}

