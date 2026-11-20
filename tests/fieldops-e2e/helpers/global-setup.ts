import { execFileSync } from "node:child_process";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { loadEnv } from "../../../scripts/utils/load-env.js";

const FIELDOPS_EVIDENCE_BUCKET = "fieldops-evidence";
const FIELDOPS_SIGNATURE_MIME = "image/svg+xml";
const JWT_COMPACT_PATTERN = /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/;
const STORAGE_AUTH_ERROR_PATTERN =
  /signature verification failed|invalid jwt|invalid compact jws|jwt malformed|no suitable key|token contains an invalid number of segments/i;

type PgClientLike = {
  connect: () => Promise<void>;
  query: (text: string, values?: unknown[]) => Promise<{ rows?: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
};

type PgClientConstructor = new (config: Record<string, unknown>) => PgClientLike;

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

function isLocalhostOrigin(origin: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

export function resolveStorageAdminKeyCandidates(env = process.env) {
  const ordered = [
    env.SUPABASE_SECRET_KEY,
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.SERVICE_ROLE_KEY,
    env.SUPABASE_SERVICE_KEY,
  ];
  const candidates: string[] = [];
  for (const candidate of ordered) {
    const key = String(candidate || "").trim();
    if (key && !candidates.includes(key)) candidates.push(key);
  }
  const jwtCandidates = candidates.filter((candidate) => JWT_COMPACT_PATTERN.test(candidate));
  if (jwtCandidates.length === 0) return [];
  return jwtCandidates;
}

export function resolveStorageAdminKey(env = process.env) {
  return resolveStorageAdminKeyCandidates(env)[0] ?? "";
}

function isStorageAuthError(message: string) {
  return STORAGE_AUTH_ERROR_PATTERN.test(String(message || ""));
}

function shouldUseDbSsl(env = process.env) {
  const mode = String(env.PGSSLMODE || "").trim().toLowerCase();
  if (mode === "disable") return false;
  if (mode === "require" || mode === "verify-ca" || mode === "verify-full") return true;
  return true;
}

function resolveDatabaseCandidates(env = process.env) {
  const seen = new Set<string>();
  const candidates: Array<{ name: string; dsn: string }> = [];
  for (const [name, value] of [
    ["DATABASE_URL_DIRECT", env.DATABASE_URL_DIRECT],
    ["DATABASE_URL", env.DATABASE_URL],
    ["DATABASE_URL_POOLER", env.DATABASE_URL_POOLER],
  ] as Array<[string, string | undefined]>) {
    const dsn = String(value || "").trim();
    if (!dsn || seen.has(dsn)) continue;
    seen.add(dsn);
    candidates.push({ name, dsn });
  }
  return candidates;
}

function resolvePgClientConstructor(override?: PgClientConstructor) {
  if (override) return override;
  // Loaded lazily so browser-harness imports do not require pg unless DB fallback is needed.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("pg").Client as PgClientConstructor;
}

function normalizeAllowedMimeTypes(raw: unknown) {
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
  }
  const value = String(raw || "").trim();
  if (!value) return [];
  if (value.startsWith("{") && value.endsWith("}")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((entry) => entry.replace(/^"|"$/g, "").trim().toLowerCase())
      .filter(Boolean);
  }
  return [value.toLowerCase()];
}

export async function ensureFieldOpsSignatureMimeSupportViaDatabase({
  env = process.env,
  ClientImpl,
}: {
  env?: NodeJS.ProcessEnv;
  ClientImpl?: PgClientConstructor;
} = {}) {
  const candidates = resolveDatabaseCandidates(env);
  if (!candidates.length) {
    return { ok: false, reason: "missing database connection env (DATABASE_URL*)" };
  }

  const Client = resolvePgClientConstructor(ClientImpl);
  const ssl = shouldUseDbSsl(env);
  let lastError: unknown = null;

  for (const candidate of candidates) {
    const client = new Client({
      connectionString: candidate.dsn,
      connectionTimeoutMillis: 10000,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
    });
    try {
      await client.connect();
      const result = await client.query(
        "SELECT allowed_mime_types FROM storage.buckets WHERE id = $1 OR name = $1 LIMIT 1",
        [FIELDOPS_EVIDENCE_BUCKET],
      );
      const row = result.rows?.[0];
      if (!row) {
        await client.end();
        return { ok: false, reason: `${FIELDOPS_EVIDENCE_BUCKET} bucket metadata missing` };
      }

      const allowedMimeTypes = normalizeAllowedMimeTypes(row.allowed_mime_types);
      if (!allowedMimeTypes.includes(FIELDOPS_SIGNATURE_MIME)) {
        const nextAllowedMimeTypes = [...new Set([...allowedMimeTypes, FIELDOPS_SIGNATURE_MIME])];
        await client.query(
          "UPDATE storage.buckets SET allowed_mime_types = $2 WHERE id = $1 OR name = $1",
          [FIELDOPS_EVIDENCE_BUCKET, nextAllowedMimeTypes],
        );
      }
      await client.end();
      return { ok: true, candidate: candidate.name };
    } catch (error) {
      lastError = error;
      try {
        await client.end();
      } catch {
        // no-op: keep original error classification.
      }
    }
  }

  return { ok: false, reason: String((lastError as Error)?.message || lastError || "database fallback failed") };
}

export async function ensureFieldOpsSignatureMimeSupport({
  env = process.env,
  createClientImpl = createClient,
  dbClientImpl,
}: {
  env?: NodeJS.ProcessEnv;
  createClientImpl?: typeof createClient;
  dbClientImpl?: PgClientConstructor;
} = {}) {
  const supabaseUrl = String(
    env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "",
  ).trim();
  const adminKeys = resolveStorageAdminKeyCandidates(env);
  if (!supabaseUrl || adminKeys.length === 0) {
    throw new Error(
      "[fieldops-global-setup] Missing JWT-compatible Supabase admin runtime required to verify FieldOps SVG signature bucket support.",
    );
  }

  let lastAuthError = "";
  for (const adminKey of adminKeys) {
    const supabase = createClientImpl(supabaseUrl, adminKey, {
      auth: { persistSession: false },
    });
    const { data, error } = await supabase.storage.getBucket(FIELDOPS_EVIDENCE_BUCKET);
    if (error || !data) {
      const message = error?.message || "bucket metadata unavailable";
      if (isStorageAuthError(message)) {
        lastAuthError = message;
        continue;
      }
      throw new Error(
        `[fieldops-global-setup] Unable to read ${FIELDOPS_EVIDENCE_BUCKET} bucket metadata: ${message}`,
      );
    }

    const allowedMimeTypes = Array.isArray(data.allowed_mime_types)
      ? data.allowed_mime_types
          .map((value) => String(value || "").trim().toLowerCase())
          .filter(Boolean)
      : [];
    if (allowedMimeTypes.includes(FIELDOPS_SIGNATURE_MIME)) {
      return;
    }

    const nextAllowedMimeTypes = [...new Set([...allowedMimeTypes, FIELDOPS_SIGNATURE_MIME])];
    const { error: updateError } = await supabase.storage.updateBucket(FIELDOPS_EVIDENCE_BUCKET, {
      public: Boolean(data.public),
      fileSizeLimit: data.file_size_limit ?? undefined,
      allowedMimeTypes: nextAllowedMimeTypes,
    });
    if (!updateError) {
      return;
    }
    if (isStorageAuthError(updateError.message)) {
      lastAuthError = updateError.message;
      continue;
    }
    throw new Error(
      `[fieldops-global-setup] Unable to add ${FIELDOPS_SIGNATURE_MIME} to ${FIELDOPS_EVIDENCE_BUCKET}: ${updateError.message}`,
    );
  }

  if (lastAuthError) {
    const fallback = await ensureFieldOpsSignatureMimeSupportViaDatabase({
      env,
      ClientImpl: dbClientImpl,
    });
    if (fallback.ok) {
      return;
    }
    throw new Error(
      `[fieldops-global-setup] Unable to verify ${FIELDOPS_EVIDENCE_BUCKET} bucket metadata with JWT-compatible admin keys, and DB fallback failed (${fallback.reason}): ${lastAuthError}`,
    );
  }
  throw new Error(`[fieldops-global-setup] Unable to verify ${FIELDOPS_EVIDENCE_BUCKET} bucket metadata.`);
}

export default async function globalSetup() {
  loadEnv();

  const portRaw = Number.parseInt(String(process.env.FIELDOPS_E2E_PORT ?? ""), 10);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 8081;
  const baseUrl =
    process.env.FIELDOPS_BASE_URL?.trim() ||
    `http://127.0.0.1:${port}`;
  const resolvedBaseUrl = resolveBaseUrl(baseUrl);

  if (!isLocalhostOrigin(new URL(resolvedBaseUrl).origin)) {
    return;
  }

  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const ensureStorageBucketsScript = path.resolve(
    repoRoot,
    "scripts",
    "ops",
    "ensure-storage-buckets.js",
  );

  execFileSync(process.execPath, [ensureStorageBucketsScript], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  await ensureFieldOpsSignatureMimeSupport();
}
