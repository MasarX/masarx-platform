import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { createClient, isAuthRetryableFetchError } from "@supabase/supabase-js";
import { getSupabaseAnonKey, getSupabaseDbSchema, getSupabaseUrl, loadE2EEnv } from "./env";

type DemoUser = {
  email: string;
  user_type?: string;
  scope_type?: string;
};

type DemoManifest = {
  mode?: string;
  password?: string;
  users?: DemoUser[];
};

type DemoContext = {
  available: boolean;
  reason?: string;
  password?: string;
  users: DemoUser[];
};

export function pickConsoleUser(context: DemoContext) {
  return context.users.find((user) => user.user_type === "super_admin") ??
    context.users.find((user) => ["platform", "tenant"].includes(user.scope_type ?? "")) ??
    null;
}

type DemoPasswordCandidateInput = {
  cachedPassword?: string;
  requestedPassword?: string;
  envPassword?: string;
  manifestPassword?: string;
};

type DemoPasswordCheckResult = {
  ok: boolean;
  reason: "valid" | "invalid_credentials" | "transient" | "unknown";
  message?: string;
};

const verifiedDemoPasswords = new Map<string, string>();

export const DEFAULT_LOCAL_DEMO_PASSWORD = "EXAMPLE_PASSWORD";

function getDemoManifestPath() {
  return (
    process.env.DEMO_ACCOUNTS_PATH ??
    path.join(process.cwd(), "tmp", "demo-accounts.json")
  );
}

function isDemoEmail(email: string) {
  return /@demo\.local$/i.test(String(email || "").trim());
}

function readDemoManifest(manifestPath: string): DemoManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as DemoManifest;
  } catch {
    return null;
  }
}

function uniqueNonEmpty(values: Array<string | undefined>) {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const next = String(value || "").trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    ordered.push(next);
  }
  return ordered;
}

export function buildDemoPasswordCandidates(input: DemoPasswordCandidateInput) {
  return uniqueNonEmpty([
    input.cachedPassword,
    input.requestedPassword,
    input.envPassword,
    input.manifestPassword,
    DEFAULT_LOCAL_DEMO_PASSWORD,
  ]);
}

export function pickDemoRecoveryPassword(input: DemoPasswordCandidateInput) {
  return (
    uniqueNonEmpty([
      input.envPassword,
      input.requestedPassword,
      input.manifestPassword,
      DEFAULT_LOCAL_DEMO_PASSWORD,
    ])[0] ?? DEFAULT_LOCAL_DEMO_PASSWORD
  );
}

export function loadDemoContext(): DemoContext {
  const manifestPath = getDemoManifestPath();
  if (!fs.existsSync(manifestPath)) {
    return {
      available: false,
      reason:
        "Fixture identity manifest missing. Provision identity fixtures before running auth matrix tests.",
      users: []
    };
  }

  const manifest = readDemoManifest(manifestPath);
  if (!manifest) {
    return {
      available: false,
      reason: "Fixture identity manifest could not be parsed.",
      users: []
    };
  }

  const envPassword = String(process.env.DEMO_PASSWORD || "").trim();
  const manifestPassword = String(manifest.password || "").trim();
  const identityStrategy = String(process.env.E2E_IDENTITY_STRATEGY || "").trim().toLowerCase();
  const manifestMode = String(manifest.mode || "").trim().toLowerCase();
  const preferManifestPassword = identityStrategy === "ephemeral" || manifestMode === "ephemeral";
  const password = preferManifestPassword
    ? manifestPassword || envPassword
    : envPassword || manifestPassword;
  if (!password) {
    return {
      available: false,
      reason:
        "Fixture identity password missing. Set DEMO_PASSWORD or re-run provisioning.",
      users: manifest.users ?? []
    };
  }

  return {
    available: true,
    password,
    users: manifest.users ?? []
  };
}

async function canSignInWithPassword(email: string, password: string) {
  const trimmedEmail = String(email || "").trim();
  const trimmedPassword = String(password || "").trim();
  if (!trimmedEmail || !trimmedPassword) {
    return {
      ok: false,
      reason: "invalid_credentials",
      message: "email or password missing",
    } satisfies DemoPasswordCheckResult;
  }

  loadE2EEnv();
  const attempts = 3;
  const baseDelayMs = 250;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const client = createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: getSupabaseDbSchema() },
    });

    try {
      const { data, error } = await client.auth.signInWithPassword({
        email: trimmedEmail,
        password: trimmedPassword,
      });
      if (!error && data?.session) {
        return {
          ok: true,
          reason: "valid",
        } satisfies DemoPasswordCheckResult;
      }

      const message = String(error?.message || "no session").trim();
      const code = String((error as { code?: string } | null)?.code || "").trim().toLowerCase();
      const status = Number((error as { status?: number } | null)?.status ?? 0);
      const normalizedMessage = message.toLowerCase();

      const invalidCredentials =
        code === "invalid_credentials" ||
        normalizedMessage.includes("invalid login credentials") ||
        normalizedMessage.includes("invalid_credentials") ||
        normalizedMessage.includes("email not confirmed") ||
        status === 400;
      if (invalidCredentials) {
        return {
          ok: false,
          reason: "invalid_credentials",
          message,
        } satisfies DemoPasswordCheckResult;
      }

      const transient =
        isAuthRetryableFetchError(error) ||
        normalizedMessage.includes("fetch failed") ||
        normalizedMessage.includes("connect timeout") ||
        normalizedMessage.includes("socket hang up") ||
        normalizedMessage.includes("econnreset") ||
        normalizedMessage.includes("etimedout") ||
        normalizedMessage.includes("enotfound") ||
        normalizedMessage.includes("eai_again") ||
        normalizedMessage.includes("temporarily unavailable") ||
        normalizedMessage.includes("network") ||
        normalizedMessage.includes("request failed") ||
        normalizedMessage.includes("server error") ||
        code === "und_err_connect_timeout" ||
        code === "econnreset" ||
        code === "etimedout" ||
        code === "enotfound" ||
        code === "eai_again" ||
        status === 429 ||
        status >= 500;

      if (!transient || attempt >= attempts) {
        const errorName = String(error?.name || "");
        const safeName = /^(AuthApiError|AuthRetryableFetchError|AuthUnknownError|AuthSessionMissingError|AuthWeakPasswordError|AuthError)$/.test(errorName)
          ? errorName : "unclassified";
        const safeCode = /^(invalid_credentials|und_err_connect_timeout|econnreset|etimedout|enotfound|eai_again)$/.test(code)
          ? code : code ? "unclassified" : "none";
        return {
          ok: false,
          reason: transient ? "transient" : "unknown",
          message: `${message} [class=${safeName} status=${Number.isFinite(status) ? status : "unavailable"} code=${safeCode}]`,
        } satisfies DemoPasswordCheckResult;
      }

      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    } finally {
      try {
        await client.auth.signOut({ scope: "local" });
      } catch {
        // Best-effort cleanup only.
      }
    }
  }

  return {
    ok: false,
    reason: "transient",
    message: "retry attempts exhausted",
  } satisfies DemoPasswordCheckResult;
}

function reprovisionDemoAccounts(password: string) {
  const manifestPath = getDemoManifestPath();
  const manifestDir = path.dirname(manifestPath);
  const repoRoot = process.cwd();
  const manifestRelPath = path.relative(repoRoot, manifestPath) || path.join("tmp", "demo-accounts.json");
  if (!fs.existsSync(manifestDir)) {
    fs.mkdirSync(manifestDir, { recursive: true });
  }

  const provisionEnv = {
    ...process.env,
    DEMO_ACCOUNTS_PROVISION_GUARD: "enabled",
    DEMO_PASSWORD: password,
  };
  const result = spawnSync(
    process.execPath,
    [path.join("scripts", "ops", "provision-demo-accounts.js"), "--out", manifestRelPath, "--password", password],
    {
      cwd: repoRoot,
      env: provisionEnv,
      encoding: "utf8",
    }
  );
  if (result.status !== 0) {
    const stderr = String(result.stderr || result.stdout || "").trim();
    throw new Error(
      `Demo account reprovision failed with code ${String(result.status)}${stderr ? `: ${stderr}` : ""}`
    );
  }
}

export async function resolveUsableDemoPassword(params: {
  email: string;
  password?: string;
}) {
  const email = String(params.email || "").trim().toLowerCase();
  const password = String(params.password || "").trim();
  if (!isDemoEmail(email)) return password;

  const cachedPassword = verifiedDemoPasswords.get(email) ?? verifiedDemoPasswords.get("*");
  const context = loadDemoContext();
  const candidates = buildDemoPasswordCandidates({
    cachedPassword,
    requestedPassword: password,
    envPassword: process.env.DEMO_PASSWORD,
    manifestPassword: context.password,
  });
  const failures: DemoPasswordCheckResult[] = [];

  for (const candidate of candidates) {
    const result = await canSignInWithPassword(email, candidate);
    if (result.ok) {
      verifiedDemoPasswords.set(email, candidate);
      verifiedDemoPasswords.set("*", candidate);
      return candidate;
    }
    failures.push(result);
  }

  const onlyInvalidCredentials =
    failures.length > 0 &&
    failures.every((failure) => failure.reason === "invalid_credentials");
  if (!onlyInvalidCredentials) {
    const transientFailure = failures.find((failure) => failure.reason === "transient");
    const unknownFailure = failures.find((failure) => failure.reason === "unknown");
    const suffix = transientFailure?.message || unknownFailure?.message;
    throw new Error(
      `Demo account credentials could not be validated for ${email}${suffix ? `: ${suffix}` : ""}.`,
    );
  }

  const recoveryPassword = pickDemoRecoveryPassword({
    cachedPassword,
    requestedPassword: password,
    envPassword: process.env.DEMO_PASSWORD,
    manifestPassword: context.password,
  });
  reprovisionDemoAccounts(recoveryPassword);

  const refreshed = loadDemoContext();
  const refreshedCandidates = buildDemoPasswordCandidates({
    cachedPassword: recoveryPassword,
    requestedPassword: recoveryPassword,
    envPassword: process.env.DEMO_PASSWORD,
    manifestPassword: refreshed.password,
  });
  const refreshedFailures: DemoPasswordCheckResult[] = [];

  for (const candidate of refreshedCandidates) {
    const result = await canSignInWithPassword(email, candidate);
    if (result.ok) {
      verifiedDemoPasswords.set(email, candidate);
      verifiedDemoPasswords.set("*", candidate);
      return candidate;
    }
    refreshedFailures.push(result);
  }

  const refreshedTransientFailure = refreshedFailures.find(
    (failure) => failure.reason === "transient",
  );
  const refreshedUnknownFailure = refreshedFailures.find(
    (failure) => failure.reason === "unknown",
  );
  const refreshedSuffix =
    refreshedTransientFailure?.message || refreshedUnknownFailure?.message;
  throw new Error(
    `Demo account credentials could not be validated for ${email}${refreshedSuffix ? `: ${refreshedSuffix}` : ""}.`,
  );
}
