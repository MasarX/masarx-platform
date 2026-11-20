import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

let envLoaded = false;

export function isTruthy(value: string | undefined) {
  return /^(1|true|yes)$/i.test(String(value ?? "").trim());
}

function normalizeEnvFilePath(envFile: string | undefined, repoRoot: string) {
  if (!envFile) return null;
  const trimmed = envFile.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, "/");
  return path.isAbsolute(normalized)
    ? normalized
    : path.resolve(repoRoot, normalized);
}

function applyEnvFile(filePath: string | null, options?: { override?: boolean }) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const override = Boolean(options?.override);
  const parsed = dotenv.parse(fs.readFileSync(filePath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!override && process.env[key]) continue;
    process.env[key] = value;
  }
}

function syncDerivedEnv(options?: { override?: boolean }) {
  const override = Boolean(options?.override);

  if ((override || !process.env.DATABASE_URL) && process.env.DATABASE_URL_DIRECT) {
    process.env.DATABASE_URL = process.env.DATABASE_URL_DIRECT;
  }

  const supabaseUrl =
    process.env.PREVIEW_SUPABASE_URL || process.env.SUPABASE_URL || "";
  if ((override || !process.env.NEXT_PUBLIC_SUPABASE_URL) && supabaseUrl) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl;
  }

  const supabaseAnonKey =
    process.env.PREVIEW_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "";
  if ((override || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) && supabaseAnonKey) {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = supabaseAnonKey;
  }
}

export function loadE2EEnv() {
  if (envLoaded) return;
  envLoaded = true;
  const repoRoot = process.cwd();
  const envRoot = path.join(repoRoot, "config", "env");
  const explicitEnv = normalizeEnvFilePath(process.env.ENV_FILE, repoRoot);
  const explicitOverride = isTruthy(process.env.ENV_FILE_OVERRIDE);
  const explicitAppend = isTruthy(process.env.ENV_FILE_APPEND);

  if (explicitEnv && fs.existsSync(explicitEnv)) {
    applyEnvFile(explicitEnv, { override: explicitOverride });
    syncDerivedEnv({ override: explicitOverride });
    if (!explicitAppend) {
      return;
    }
  }

  const candidates = [
    path.join(envRoot, ".env.local"),
    path.join(envRoot, ".env.cloud"),
    path.join(envRoot, ".env"),
    path.join(repoRoot, ".env"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    applyEnvFile(candidate);
  }

  syncDerivedEnv();
}

export const loadEnv = loadE2EEnv;

export function isStrictE2EEnv() {
  loadE2EEnv();
  return isTruthy(process.env.STRICT_E2E_GATE_ENV) || isTruthy(process.env.CI);
}

export function isVisualE2EEnv() {
  loadE2EEnv();
  return isTruthy(process.env.E2E_VISUAL);
}

export function getDatabaseUrl() {
  loadE2EEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL not set for E2E coverage query.");
  }
  return databaseUrl;
}

export function getSupabaseUrl() {
  loadE2EEnv();
  const url =
    process.env.PREVIEW_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "";
  if (!url) {
    throw new Error("SUPABASE_URL not set for E2E auth queries.");
  }
  return url;
}

export function getSupabaseAnonKey() {
  loadE2EEnv();
  const anonKey =
    process.env.PREVIEW_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";
  if (!anonKey) {
    throw new Error("SUPABASE_ANON_KEY not set for E2E auth queries.");
  }
  return anonKey;
}

export function getSupabaseDbSchema() {
  loadE2EEnv();
  const schema =
    process.env.E2E_SUPABASE_DB_SCHEMA ||
    process.env.SUPABASE_DB_SCHEMA ||
    process.env.NEXT_PUBLIC_SUPABASE_DB_SCHEMA ||
    process.env.NEXT_PUBLIC_SUPABASE_SCHEMA ||
    process.env.SUPABASE_SCHEMA ||
    "";
  return schema.trim() || "api";
}
