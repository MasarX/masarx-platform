import type { ConfigContext, ExpoConfig } from "expo/config";

const { loadPublicEnv } = require("../../scripts/utils/load-public-env");
const {
  loadFieldopsReleaseContract,
  resolveFieldopsAppSlug,
} = require("../../scripts/ops/fieldops-release-contract");

loadPublicEnv({ appDir: __dirname });

function readPackageVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("./package.json");
    return typeof pkg?.version === "string" ? pkg.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function readEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeUrlForCompare(value: string): string {
  return value.trim().replace(/\/+$/g, "");
}

const PLACEHOLDER_SUPABASE_URL = ["https://example", "supabase.co"].join(".");
const ANDROID_EMULATOR_SUPABASE_URL_ENV = "FIELDOPS_ANDROID_EMULATOR_SUPABASE_URL";

function isPlaceholderSupabaseUrl(value: string): boolean {
  return normalizeUrlForCompare(value) === PLACEHOLDER_SUPABASE_URL;
}

function isPlaceholderSupabaseAnonKey(value: string): boolean {
  return value.trim() === "dummy-anon-key";
}

function isLocalHttpUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:") return false;
    return ["127.0.0.1", "localhost", "192.0.2.10"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function resolveSupabaseUrl(options: {
  buildProfile?: string;
  isEasBuild: boolean;
}): string | undefined {
  const androidEmulatorUrl = readEnvString(process.env[ANDROID_EMULATOR_SUPABASE_URL_ENV]);
  if (androidEmulatorUrl) {
    if (options.isEasBuild || options.buildProfile) {
      throw new Error(
        `[fieldops-config] ${ANDROID_EMULATOR_SUPABASE_URL_ENV} is local-only and cannot be used with EAS_BUILD or FIELDOPS_BUILD_PROFILE.`
      );
    }
    if (!isLocalHttpUrl(androidEmulatorUrl)) {
      throw new Error(
        `[fieldops-config] ${ANDROID_EMULATOR_SUPABASE_URL_ENV} must be a local http URL for Android emulator builds.`
      );
    }
    return androidEmulatorUrl;
  }

  const publicUrl = readEnvString(process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (publicUrl && !isPlaceholderSupabaseUrl(publicUrl)) {
    return publicUrl;
  }
  const fallbackUrl = readEnvString(process.env.SUPABASE_URL);
  if (fallbackUrl && !isPlaceholderSupabaseUrl(fallbackUrl)) {
    return fallbackUrl;
  }
  return publicUrl ?? fallbackUrl;
}

function resolveSupabaseAnonKey(): string | undefined {
  const publicAnonKey = readEnvString(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  if (publicAnonKey && !isPlaceholderSupabaseAnonKey(publicAnonKey)) {
    return publicAnonKey;
  }
  const fallbackAnonKey = readEnvString(process.env.SUPABASE_ANON_KEY);
  if (fallbackAnonKey && !isPlaceholderSupabaseAnonKey(fallbackAnonKey)) {
    return fallbackAnonKey;
  }
  return publicAnonKey ?? fallbackAnonKey;
}

function buildSupabaseFunctionEndpoint(
  supabaseUrl: string | undefined,
  functionName: string,
): string | undefined {
  const normalized = supabaseUrl ? normalizeUrlForCompare(supabaseUrl) : "";
  return normalized ? `${normalized}/functions/v1/${functionName}` : undefined;
}

function resolveAndroidEmulatorHostOrigin(value: string | undefined): string | undefined {
  const normalized = value ? normalizeUrlForCompare(value) : "";
  if (!normalized) return undefined;
  try {
    const parsed = new URL(normalized);
    if (parsed.hostname === "192.0.2.10") {
      parsed.hostname = "127.0.0.1";
      return parsed.origin;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function canResolveConfigPlugin(pluginName: string): boolean {
  try {
    require.resolve(pluginName, { paths: [__dirname] });
    return true;
  } catch {
    return false;
  }
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const buildProfile = readEnvString(process.env.FIELDOPS_BUILD_PROFILE);
  const isEasBuild = readEnvString(process.env.EAS_BUILD) === "true";
  const requireNativeIds = isEasBuild || Boolean(buildProfile);

  const appIdSuffix = readEnvString(process.env.NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX) ?? "";
  const iosBundleBase = readEnvString(process.env.NEXT_PUBLIC_IOS_BUNDLE_IDENTIFIER_FIELDOPS);
  const androidPackageBase = readEnvString(process.env.NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS);
  const easProjectId = readEnvString(process.env.NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS);
  const fieldopsReleaseContract = loadFieldopsReleaseContract(__dirname);
  const fieldopsAppSlug =
    resolveFieldopsAppSlug(fieldopsReleaseContract.contract) ||
    readEnvString(config.slug) ||
    "fieldops";
  const locationAlwaysPermission =
    readEnvString(process.env.NEXT_PUBLIC_LOCATION_ALWAYS_PERMISSION_FIELDOPS) ??
    "Allow Fieldops to access your location in the background to capture operational location pings.";

  if (requireNativeIds) {
    const missing = [
      !resolveFieldopsAppSlug(fieldopsReleaseContract.contract)
        ? `FieldOps release contract app.slug (${fieldopsReleaseContract.contractPath})`
        : null,
      !iosBundleBase ? "NEXT_PUBLIC_IOS_BUNDLE_IDENTIFIER_FIELDOPS" : null,
      !androidPackageBase ? "NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS" : null,
      !easProjectId ? "NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS" : null,
    ].filter(Boolean);

    if (missing.length) {
      throw new Error(
        `[fieldops-config] Missing required env for native builds: ${missing.join(
          ", "
        )}. See docs/ops/runbooks/mobile-store-release.md.`
      );
    }
  }

  const iosBundleIdentifier = iosBundleBase ? `${iosBundleBase}${appIdSuffix}` : undefined;
  const androidPackage = androidPackageBase
    ? `${androidPackageBase}${appIdSuffix}`
    : config.android?.package ?? "co.masarx.fieldops.dev";
  const updatesUrl = easProjectId ? `https://u.expo.dev/${easProjectId}` : undefined;

  const appName =
    readEnvString(process.env.NEXT_PUBLIC_APP_NAME) ??
    readEnvString(config.name) ??
    "Fieldops";
  const supabaseUrl = resolveSupabaseUrl({ buildProfile, isEasBuild });
  const usesAndroidEmulatorSupabaseUrl = Boolean(
    readEnvString(process.env[ANDROID_EMULATOR_SUPABASE_URL_ENV]),
  );
  const supabaseAnonKey = resolveSupabaseAnonKey();
  const allowLocalCleartext = !isEasBuild && !buildProfile && isLocalHttpUrl(supabaseUrl);
  const driverSignupEndpoint = usesAndroidEmulatorSupabaseUrl
    ? buildSupabaseFunctionEndpoint(supabaseUrl, "driver-signup-intake")
    : readEnvString(process.env.NEXT_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ENDPOINT) ||
      readEnvString(process.env.LANDING_DRIVER_SIGNUP_ENDPOINT);
  const driverStatusEndpoint = usesAndroidEmulatorSupabaseUrl
    ? buildSupabaseFunctionEndpoint(supabaseUrl, "driver-application-status")
    : readEnvString(process.env.NEXT_PUBLIC_FIELDOPS_DRIVER_STATUS_ENDPOINT) ||
      readEnvString(process.env.LANDING_DRIVER_STATUS_ENDPOINT) ||
      readEnvString(process.env.LANDING_DRIVER_APPLICATION_STATUS_ENDPOINT);
  const driverSignupOrigin = usesAndroidEmulatorSupabaseUrl
    ? resolveAndroidEmulatorHostOrigin(supabaseUrl)
    : readEnvString(process.env.NEXT_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ORIGIN) ||
      readEnvString(process.env.LANDING_SITE_URL);

  const updates = updatesUrl
    ? {
        ...(config.updates ?? {}),
        url: updatesUrl,
      }
    : config.updates;

  const locationPluginOptions = {
    isAndroidBackgroundLocationEnabled: true,
    isIosBackgroundLocationEnabled: true,
    locationAlwaysAndWhenInUsePermission: locationAlwaysPermission,
  };

  type PluginEntry = NonNullable<ExpoConfig["plugins"]>[number];
  const basePlugins = (Array.isArray(config.plugins) ? [...config.plugins] : []) as PluginEntry[];
  const fieldopsAndroidCleartextPlugin = "./plugins/with-fieldops-android-cleartext";
  const hasFieldopsAndroidCleartextPlugin = basePlugins.some((entry) => {
    if (typeof entry === "string") return entry === fieldopsAndroidCleartextPlugin;
    return Array.isArray(entry) && entry[0] === fieldopsAndroidCleartextPlugin;
  });
  if (!hasFieldopsAndroidCleartextPlugin) {
    basePlugins.push(fieldopsAndroidCleartextPlugin);
  }

  const hasNotificationsPlugin = basePlugins.some((entry) => {
    if (typeof entry === "string") return entry === "expo-notifications";
    return Array.isArray(entry) && entry[0] === "expo-notifications";
  });
  if (!hasNotificationsPlugin && canResolveConfigPlugin("expo-notifications")) {
    basePlugins.push("expo-notifications");
  }

  const hasSentryPlugin = basePlugins.some((entry) => {
    if (typeof entry === "string") return entry === "@sentry/react-native/expo";
    return Array.isArray(entry) && entry[0] === "@sentry/react-native/expo";
  });
  if (!hasSentryPlugin && canResolveConfigPlugin("@sentry/react-native/expo")) {
    basePlugins.push("@sentry/react-native/expo");
  }
  let hasLocationPlugin = false;
  const nextPlugins: PluginEntry[] = basePlugins.map((entry) => {
    if (typeof entry === "string" && entry === "expo-location") {
      hasLocationPlugin = true;
      return ["expo-location", locationPluginOptions];
    }
    if (Array.isArray(entry) && entry[0] === "expo-location") {
      hasLocationPlugin = true;
      const existingOptions =
        entry.length > 1 && entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1])
          ? entry[1]
          : {};
      return ["expo-location", { ...existingOptions, ...locationPluginOptions }];
    }
    return entry;
  });
  if (!hasLocationPlugin) {
    nextPlugins.push(["expo-location", locationPluginOptions]);
  }

  const existingInfoPlist = { ...(config.ios?.infoPlist ?? {}) } as Record<string, unknown>;
  const uiBackgroundModes = Array.isArray(existingInfoPlist.UIBackgroundModes)
    ? existingInfoPlist.UIBackgroundModes.filter((item): item is string => typeof item === "string")
    : [];
  const nextBackgroundModes = Array.from(new Set([...uiBackgroundModes, "location"]));
  const androidConfig = {
    ...config.android,
    package: androidPackage ?? config.android?.package,
    ...(allowLocalCleartext || (config.android as typeof config.android & { usesCleartextTraffic?: boolean } | undefined)
      ?.usesCleartextTraffic
      ? { usesCleartextTraffic: true }
      : {}),
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#ffffff",
    },
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
  } as ExpoConfig["android"] & { usesCleartextTraffic?: boolean };

  return {
    ...config,
    name: appName,
    slug: fieldopsAppSlug,
    version: readPackageVersion(),
    runtimeVersion: { policy: "appVersion" },
    ...(updates ? { updates } : {}),
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    splash: {
      image: "./assets/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#ffffff",
    },
    ios: {
      ...config.ios,
      bundleIdentifier: iosBundleIdentifier ?? config.ios?.bundleIdentifier,
      supportsTablet: true,
      infoPlist: {
        ...existingInfoPlist,
        NSCameraUsageDescription:
          "Allow Fieldops to use the camera to scan barcodes for operational tasks.",
        NSLocationWhenInUseUsageDescription:
          "Allow Fieldops to access your location to capture location pings for operational tasks.",
        NSLocationAlwaysAndWhenInUseUsageDescription: locationAlwaysPermission,
        UIBackgroundModes: nextBackgroundModes,
      },
    },
    android: {
      ...androidConfig,
    },
    web: {
      favicon: "./assets/favicon.png",
    },
    plugins: nextPlugins,
    extra: {
      ...config.extra,
      ...(easProjectId ? { eas: { ...(config.extra as any)?.eas, projectId: easProjectId } } : {}),
      NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
      NEXT_PUBLIC_APP_BASE_PATH: process.env.NEXT_PUBLIC_APP_BASE_PATH,
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
      NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL: process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL,
      NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
      NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
      NEXT_PUBLIC_AUTH_METHODS: process.env.NEXT_PUBLIC_AUTH_METHODS,
      NEXT_PUBLIC_LOCALE: process.env.NEXT_PUBLIC_LOCALE,
      NEXT_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ENDPOINT: driverSignupEndpoint,
      NEXT_PUBLIC_FIELDOPS_DRIVER_STATUS_ENDPOINT: driverStatusEndpoint,
      NEXT_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ORIGIN: driverSignupOrigin,
      NEXT_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ROLES:
        process.env.NEXT_PUBLIC_FIELDOPS_DRIVER_SIGNUP_ROLES,
    },
  };
};
