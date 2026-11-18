import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function trimTrailingSlash(value: string) {
  return value.length > 1 ? value.replace(/\/+$/g, "") : value;
}

function resolveBaseUrl(value: string) {
  try {
    const parsed = new URL(value);
    return trimTrailingSlash(parsed.origin + parsed.pathname);
  } catch (error) {
    throw new Error(
      `Invalid FIELDOPS_BASE_URL "${value}". Expected an absolute URL like "https://www.example.com".`,
      { cause: error },
    );
  }
}

function createPublicRuntimeFingerprint(env: NodeJS.ProcessEnv) {
  const publicEntries = Object.entries(env)
    .filter(
      ([key, value]) =>
        /^(NEXT_PUBLIC_|EXPO_PUBLIC_)/.test(key) &&
        typeof value === "string" &&
        value.trim().length > 0,
    )
    .map(([key, value]) => [key, value.trim()] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(publicEntries))
    .digest("hex");

  return digest.slice(0, 12) || "default-runtime";
}

function copyPublicEnv(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        /^(NEXT_PUBLIC_|EXPO_PUBLIC_)/.test(key) &&
        typeof value === "string" &&
        value.trim().length > 0,
    ),
  );
}

function copyProcessBootstrapEnv(env: NodeJS.ProcessEnv) {
  const keys = [
    "PATH",
    "Path",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "SHELL",
    "NODE_OPTIONS",
    "NPM_CONFIG_CACHE",
    "npm_config_cache",
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      out[key] = value;
    }
  }
  return out;
}

export function buildFieldOpsWebServerEnv(params: {
  env: NodeJS.ProcessEnv;
  fieldopsTempDir?: string | null;
  supabaseUrl: string;
  supabaseAnonKey: string;
}) {
  const { env, fieldopsTempDir, supabaseUrl, supabaseAnonKey } = params;
  return {
    ...copyProcessBootstrapEnv(env),
    ...copyPublicEnv(env),
    CI: "1",
    EXPO_NO_TELEMETRY: "1",
    EXPO_NO_METRO_WORKSPACE_ROOT: "1",
    EXPO_NO_DOTENV: "1",
    ...(fieldopsTempDir
      ? {
          TEMP: fieldopsTempDir,
          TMP: fieldopsTempDir,
          TMPDIR: fieldopsTempDir,
        }
      : {}),
    NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL || supabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY || supabaseAnonKey,
    NEXT_PUBLIC_AUTH_METHODS: env.NEXT_PUBLIC_AUTH_METHODS || "password",
  };
}

export function isLocalhostOrigin(origin: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

export function resolveFieldOpsPlaywrightRuntime(env: NodeJS.ProcessEnv) {
  const isCi = Boolean(env.CI);
  const portRaw = Number.parseInt(String(env.FIELDOPS_E2E_PORT ?? ""), 10);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 8081;
  const reuseExistingServerSetting = String(env.FIELDOPS_E2E_REUSE_SERVER ?? "").trim();
  const reuseExistingServer = reuseExistingServerSetting
    ? /^(1|true|yes)$/i.test(reuseExistingServerSetting)
    : false;
  const shouldClearMetroCache =
    /^(1|true|yes)$/i.test(String(env.FIELDOPS_E2E_CLEAR_CACHE ?? "").trim());

  const baseUrl =
    String(env.FIELDOPS_BASE_URL ?? "").trim() || `http://127.0.0.1:${port}`;
  const resolvedBaseUrl = resolveBaseUrl(baseUrl);
  const resolvedOrigin = new URL(resolvedBaseUrl).origin;
  const shouldStartServer = isLocalhostOrigin(resolvedOrigin);
  const fieldopsWebDir = path.resolve(__dirname, "..", "..", "..", "apps", "fieldops");
  const fieldopsWebCommand = `npm run web -- --port ${port}${shouldClearMetroCache ? " --clear" : ""}`;
  const shouldUseIsolatedTempDir = process.platform === "win32";
  const publicRuntimeFingerprint = createPublicRuntimeFingerprint(env);
  const fieldopsTempDir = shouldUseIsolatedTempDir
    ? path.resolve(
        fieldopsWebDir,
        ".expo",
        "playwright-temp",
        String(port),
        publicRuntimeFingerprint,
      )
    : null;

  if (fieldopsTempDir) {
    fs.mkdirSync(fieldopsTempDir, { recursive: true });
  }

  const supabaseUrl =
    String(env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || "").trim();
  const supabaseAnonKey =
    String(env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || "").trim();

  return {
    port,
    reuseExistingServer,
    resolvedBaseUrl,
    resolvedOrigin,
    shouldStartServer,
    fieldopsWebDir,
    fieldopsWebCommand,
    webServerEnv: buildFieldOpsWebServerEnv({
      env,
      fieldopsTempDir,
      supabaseUrl,
      supabaseAnonKey,
    }),
  };
}

export function forceCleanFieldOpsPortListener(port: number) {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const scriptPath = path.resolve(repoRoot, "scripts", "tests", "stop-port-listeners.js");
  const result = spawnSync(process.execPath, [scriptPath, String(port)], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Failed to clear FieldOps port listener for ${port} (exit ${result.status ?? "unknown"}).`,
    );
  }
}
