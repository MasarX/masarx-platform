import { createClient, isAuthRetryableFetchError, type SupabaseClient } from "@supabase/supabase-js";
import { createBrowserClient as createSupabaseBrowserClient } from "@supabase/ssr";
import { getSupabaseAnonKey, getSupabaseDbSchema, getSupabaseUrl } from "./env";
import { resolveUsableDemoPassword } from "./demo-accounts";

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function getErrorCode(error: unknown): string | null {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const code = record?.code;
  if (typeof code === "string" && code.trim()) return code;
  const cause = record?.cause;
  if (cause && typeof cause === "object") {
    const causeRecord = cause as Record<string, unknown>;
    const causeCode = causeRecord.code;
    if (typeof causeCode === "string" && causeCode.trim()) return causeCode;
  }
  return null;
}

function isTransientNetworkError(error: unknown) {
  const cause = error && typeof error === "object"
    ? (error as { cause?: unknown }).cause
    : undefined;
  if (isAuthRetryableFetchError(error) || isAuthRetryableFetchError(cause)) return true;
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("fetch failed")) return true;
  if (message.includes("connect timeout")) return true;
  if (message.includes("socket hang up")) return true;
  if (message.includes("econnreset")) return true;
  if (message.includes("etimedout")) return true;
  if (message.includes("enotfound")) return true;
  if (message.includes("eai_again")) return true;

  const code = getErrorCode(error);
  if (!code) return false;
  return [
    "UND_ERR_CONNECT_TIMEOUT",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
  ].includes(code);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RetryConfig = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  label: string;
};

type BrowserCookieOptions = {
  path?: string;
  domain?: string;
  maxAge?: number;
  httpOnly?: boolean;
  sameSite?: string;
  secure?: boolean;
};

export type BrowserAuthCookie = {
  name: string;
  value: string;
  options: BrowserCookieOptions;
};

async function withRetry<T>(fn: () => Promise<T>, config: RetryConfig): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < config.attempts && isTransientNetworkError(error);
      if (!shouldRetry) throw error;
      const exponent = Math.min(attempt - 1, 6);
      const delayMs = Math.min(config.maxDelayMs, config.baseDelayMs * Math.pow(2, exponent));
      const jitterMs = Math.floor(Math.random() * 250);
      await sleep(delayMs + jitterMs);
    }
  }

  throw lastError ?? new Error(`${config.label}: retry attempts exhausted`);
}

export async function createAuthedSupabaseClient(params: {
  email: string;
  password: string;
  label?: string;
}): Promise<SupabaseClient> {
  const { email } = params;
  const password = await resolveUsableDemoPassword({
    email,
    password: params.password,
  });
  const label = params.label ?? email;
  const attempts = parsePositiveInt(process.env.E2E_SUPABASE_SIGNIN_ATTEMPTS, 4);
  const baseDelayMs = parsePositiveInt(process.env.E2E_SUPABASE_SIGNIN_DELAY_MS, 750);
  const maxDelayMs = parsePositiveInt(process.env.E2E_SUPABASE_SIGNIN_MAX_DELAY_MS, 5_000);

  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();
  const schema = getSupabaseDbSchema();
  return withRetry(
    async () => {
      const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        db: { schema },
      });

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error || !data?.session) {
        const message = error?.message || "no session";
        const wrapped = new Error(`Supabase sign-in failed for ${label}: ${message}`);
        (wrapped as any).cause = error;
        throw wrapped;
      }

      return supabase;
    },
    {
      attempts,
      baseDelayMs,
      maxDelayMs,
      label: `signIn:${label}`,
    }
  );
}

export async function createAuthedSupabaseBrowserCookies(params: {
  email: string;
  password: string;
  label?: string;
}): Promise<BrowserAuthCookie[]> {
  const { email } = params;
  const password = await resolveUsableDemoPassword({
    email,
    password: params.password,
  });
  const label = params.label ?? email;
  const attempts = parsePositiveInt(process.env.E2E_SUPABASE_SIGNIN_ATTEMPTS, 4);
  const baseDelayMs = parsePositiveInt(process.env.E2E_SUPABASE_SIGNIN_DELAY_MS, 750);
  const maxDelayMs = parsePositiveInt(process.env.E2E_SUPABASE_SIGNIN_MAX_DELAY_MS, 5_000);
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();
  const schema = getSupabaseDbSchema();

  return withRetry(
    async () => {
      const cookieJar = new Map<string, BrowserAuthCookie>();
      const supabase = createSupabaseBrowserClient(supabaseUrl, supabaseAnonKey, {
        db: { schema },
        isSingleton: false,
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        cookies: {
          getAll() {
            return Array.from(cookieJar.values()).map(({ name, value }) => ({
              name,
              value,
            }));
          },
          setAll(cookiesToSet: Array<BrowserAuthCookie>) {
            for (const cookie of cookiesToSet) {
              if ((cookie.options?.maxAge ?? 0) === 0 || cookie.value === "") {
                cookieJar.delete(cookie.name);
                continue;
              }
              cookieJar.set(cookie.name, {
                name: cookie.name,
                value: cookie.value,
                options: { ...cookie.options },
              });
            }
          },
        },
      });

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error || !data?.session) {
        const message = error?.message || "no session";
        const wrapped = new Error(`Supabase browser sign-in failed for ${label}: ${message}`);
        (wrapped as any).cause = error;
        throw wrapped;
      }

      const cookies = Array.from(cookieJar.values());
      if (!cookies.length) {
        throw new Error(`Supabase browser sign-in failed for ${label}: no auth cookies created`);
      }
      return cookies;
    },
    {
      attempts,
      baseDelayMs,
      maxDelayMs,
      label: `browserSignIn:${label}`,
    }
  );
}

export async function rpcWithRetry<T>(
  supabase: SupabaseClient,
  fnName: string,
  args?: Record<string, unknown> | null,
  options?: { label?: string }
): Promise<{ data: T | null; error: unknown }> {
  const attempts = parsePositiveInt(process.env.E2E_SUPABASE_RPC_ATTEMPTS, 3);
  const baseDelayMs = parsePositiveInt(process.env.E2E_SUPABASE_RPC_DELAY_MS, 500);
  const maxDelayMs = parsePositiveInt(process.env.E2E_SUPABASE_RPC_MAX_DELAY_MS, 3_000);
  const label = options?.label ?? `rpc:${fnName}`;

  return withRetry(
    async () => {
      const result = await supabase.rpc<T>(fnName, args ?? undefined);
      if (result.error && isTransientNetworkError(result.error)) {
        const wrapped = new Error(`${label}: ${getErrorMessage(result.error)}`);
        (wrapped as any).cause = result.error;
        throw wrapped;
      }
      return { data: (result.data ?? null) as T | null, error: result.error ?? null };
    },
    { attempts, baseDelayMs, maxDelayMs, label }
  );
}

export async function signOutSupabaseClient(
  supabase: SupabaseClient,
  options?: { label?: string }
) {
  const attempts = parsePositiveInt(process.env.E2E_SUPABASE_SIGNOUT_ATTEMPTS, 2);
  const baseDelayMs = parsePositiveInt(process.env.E2E_SUPABASE_SIGNOUT_DELAY_MS, 350);
  const maxDelayMs = parsePositiveInt(process.env.E2E_SUPABASE_SIGNOUT_MAX_DELAY_MS, 1_500);
  const label = options?.label ?? "signOut";

  try {
    await withRetry(
      async () => {
        const result = await supabase.auth.signOut({ scope: "local" });
        if (result?.error && isTransientNetworkError(result.error)) {
          const wrapped = new Error(`${label}: ${getErrorMessage(result.error)}`);
          (wrapped as any).cause = result.error;
          throw wrapped;
        }
      },
      { attempts, baseDelayMs, maxDelayMs, label }
    );
  } catch {
    // Best-effort cleanup. Avoid flaking suites on sign-out connectivity.
  }
}
