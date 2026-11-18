import Constants from "expo-constants";

import { getPublicConfigFromEnv } from "@masarx/config";

export type ExpoExtra = Record<string, unknown>;

type PublicConfigEnvKey =
  | "NEXT_PUBLIC_APP_NAME"
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "NEXT_PUBLIC_SUPABASE_ANON_KEY"
  | "NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL"
  | "NEXT_PUBLIC_SENTRY_DSN"
  | "NEXT_PUBLIC_SENTRY_ENVIRONMENT"
  | "NEXT_PUBLIC_AUTH_METHODS"
  | "NEXT_PUBLIC_LOCALE"
  | "NEXT_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ENDPOINT"
  | "NEXT_PUBLIC_FIELDOPS_DRIVER_STATUS_ENDPOINT"
  | "NEXT_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ORIGIN"
  | "NEXT_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ROLES";

const PUBLIC_CONFIG_ENV_KEYS: readonly PublicConfigEnvKey[] = [
  "NEXT_PUBLIC_APP_NAME",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL",
  "NEXT_PUBLIC_SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_ENVIRONMENT",
  "NEXT_PUBLIC_AUTH_METHODS",
  "NEXT_PUBLIC_LOCALE",
  "NEXT_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ENDPOINT",
  "NEXT_PUBLIC_FIELDOPS_DRIVER_STATUS_ENDPOINT",
  "NEXT_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ORIGIN",
  "NEXT_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ROLES",
] as const;

const EXPO_PUBLIC_ENV_ALIASES: Record<PublicConfigEnvKey, string> = {
  NEXT_PUBLIC_APP_NAME: "EXPO_PUBLIC_APP_NAME",
  NEXT_PUBLIC_SUPABASE_URL: "EXPO_PUBLIC_SUPABASE_URL",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "EXPO_PUBLIC_SUPABASE_ANON_KEY",
  NEXT_PUBLIC_SENTRY_DSN: "EXPO_PUBLIC_SENTRY_DSN",
  NEXT_PUBLIC_SENTRY_ENVIRONMENT: "EXPO_PUBLIC_SENTRY_ENVIRONMENT",
  NEXT_PUBLIC_AUTH_METHODS: "EXPO_PUBLIC_AUTH_METHODS",
  NEXT_PUBLIC_LOCALE: "EXPO_PUBLIC_LOCALE",
  NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL: "EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL",
  NEXT_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ENDPOINT: "EXPO_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ENDPOINT",
  NEXT_PUBLIC_FIELDOPS_DRIVER_STATUS_ENDPOINT: "EXPO_PUBLIC_FIELDOPS_DRIVER_STATUS_ENDPOINT",
  NEXT_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ORIGIN: "EXPO_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ORIGIN",
  NEXT_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ROLES: "EXPO_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ROLES",
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function readExtraString(extra: ExpoExtra, key: string): string | undefined {
  const value = extra[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readPublicEnvFallback(): ExpoExtra {
  const source = (process.env ?? {}) as Record<string, unknown>;
  const fallback: ExpoExtra = {};
  for (const key of PUBLIC_CONFIG_ENV_KEYS) {
    const value = source[key] ?? source[EXPO_PUBLIC_ENV_ALIASES[key]];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    fallback[key] = trimmed;
  }
  return fallback;
}

export function resolveExpoExtra(extra?: ExpoExtra): ExpoExtra {
  const constants = asRecord(Constants as unknown);
  const expoConfig = asRecord(constants.expoConfig);
  const manifest = asRecord(constants.manifest);
  const manifest2 = asRecord(constants.manifest2);
  const manifest2Extra = asRecord(manifest2.extra);
  const expoClient = asRecord(manifest2Extra.expoClient);

  // Prefer explicit and runtime-resolved fields over env fallbacks.
  return {
    ...readPublicEnvFallback(),
    ...asRecord(manifest.extra),
    ...asRecord(manifest2Extra.extra),
    ...manifest2Extra,
    ...asRecord(expoClient.extra),
    ...asRecord(expoConfig.extra),
    ...asRecord(constants.extra),
    ...asRecord(extra),
  };
}

export function getPublicConfigFromExpo(extra: ExpoExtra = {}) {
  const resolvedExtra = resolveExpoExtra(extra);
  return getPublicConfigFromEnv({
    NEXT_PUBLIC_APP_NAME: readExtraString(resolvedExtra, "NEXT_PUBLIC_APP_NAME"),
    NEXT_PUBLIC_SUPABASE_URL: readExtraString(resolvedExtra, "NEXT_PUBLIC_SUPABASE_URL"),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: readExtraString(resolvedExtra, "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL: readExtraString(resolvedExtra, "NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL"),
    NEXT_PUBLIC_SENTRY_DSN: readExtraString(resolvedExtra, "NEXT_PUBLIC_SENTRY_DSN"),
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: readExtraString(resolvedExtra, "NEXT_PUBLIC_SENTRY_ENVIRONMENT"),
    NEXT_PUBLIC_AUTH_METHODS: readExtraString(resolvedExtra, "NEXT_PUBLIC_AUTH_METHODS"),
    NEXT_PUBLIC_LOCALE: readExtraString(resolvedExtra, "NEXT_PUBLIC_LOCALE"),
  });
}
