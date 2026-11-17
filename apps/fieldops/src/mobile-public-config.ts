import Constants from "expo-constants";
import { resolveDriverSignupUrl } from "./mobile-driver-signup";

import { getPublicConfigFromEnv } from "@masarx/config";

export type ExpoExtra = Record<string, unknown>;

type PublicConfigEnvKey =
  | "NEXT_PUBLIC_APP_NAME"
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "NEXT_PUBLIC_SUPABASE_ANON_KEY"
  | "NEXT_PUBLIC_SENTRY_DSN"
  | "NEXT_PUBLIC_SENTRY_ENVIRONMENT"
  | "NEXT_PUBLIC_AUTH_METHODS"
  | "NEXT_PUBLIC_DRIVER_SIGNUP_URL"
  | "NEXT_PUBLIC_LOCALE";

const PUBLIC_CONFIG_ENV_KEYS: readonly PublicConfigEnvKey[] = [
  "NEXT_PUBLIC_APP_NAME",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_ENVIRONMENT",
  "NEXT_PUBLIC_AUTH_METHODS",
  "NEXT_PUBLIC_DRIVER_SIGNUP_URL",
  "NEXT_PUBLIC_LOCALE",
] as const;

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
  // Expo only inlines EXPO_PUBLIC_* values when Metro can see direct dot-notation
  // references. Keep these explicit so web/native bundles receive the same public
  // configuration even when Constants.expoConfig.extra is unavailable.
  const source: Record<PublicConfigEnvKey, unknown> = {
    NEXT_PUBLIC_APP_NAME:
      process.env.EXPO_PUBLIC_APP_NAME ?? process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_SUPABASE_URL:
      process.env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SENTRY_DSN:
      process.env.EXPO_PUBLIC_SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT:
      process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    NEXT_PUBLIC_AUTH_METHODS:
      process.env.EXPO_PUBLIC_AUTH_METHODS ?? process.env.NEXT_PUBLIC_AUTH_METHODS,
    NEXT_PUBLIC_DRIVER_SIGNUP_URL:
      process.env.EXPO_PUBLIC_DRIVER_SIGNUP_URL ?? process.env.NEXT_PUBLIC_DRIVER_SIGNUP_URL,
    NEXT_PUBLIC_LOCALE:
      process.env.EXPO_PUBLIC_LOCALE ?? process.env.NEXT_PUBLIC_LOCALE,
  };
  const fallback: ExpoExtra = {};
  for (const key of PUBLIC_CONFIG_ENV_KEYS) {
    const value = source[key];
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
  return { ...getPublicConfigFromEnv({
    NEXT_PUBLIC_APP_NAME: readExtraString(resolvedExtra, "NEXT_PUBLIC_APP_NAME"),
    NEXT_PUBLIC_SUPABASE_URL: readExtraString(resolvedExtra, "NEXT_PUBLIC_SUPABASE_URL"),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: readExtraString(resolvedExtra, "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    NEXT_PUBLIC_SENTRY_DSN: readExtraString(resolvedExtra, "NEXT_PUBLIC_SENTRY_DSN"),
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: readExtraString(resolvedExtra, "NEXT_PUBLIC_SENTRY_ENVIRONMENT"),
    NEXT_PUBLIC_AUTH_METHODS: readExtraString(resolvedExtra, "NEXT_PUBLIC_AUTH_METHODS"),
    NEXT_PUBLIC_LOCALE: readExtraString(resolvedExtra, "NEXT_PUBLIC_LOCALE"),
  }), driverSignupUrl: resolveDriverSignupUrl(readExtraString(resolvedExtra, "NEXT_PUBLIC_DRIVER_SIGNUP_URL")) };
}
