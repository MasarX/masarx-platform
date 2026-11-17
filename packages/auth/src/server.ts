import "server-only";
import { cookies } from "next/headers";
import {
  createServerClient as createSupabaseServerClient,
  type CookieOptions,
} from "@supabase/ssr";
import { getPublicConfig } from "@masarx/config";

type SupabaseServerClient = ReturnType<typeof createSupabaseServerClient>;
type CookieLike = { name: string; value: string };
type JsonRecord = Record<string, unknown>;
type TrustedSessionIdentity = {
  accessToken: string;
  user: JsonRecord & { id: string };
};

const BASE64_PREFIX = "base64-";
const CHUNK_SUFFIX_REGEX = /^(.*)\.(\d+)$/;

function normalizeCookieValue(value: string) {
  const normalized = value.trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith("\"") && normalized.endsWith("\"")) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    return normalized.slice(1, -1).trim();
  }
  return normalized;
}

function decodeBase64Url(value: string) {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function decodeCookieValue(value: string) {
  const normalized = normalizeCookieValue(value);
  if (normalized.startsWith(BASE64_PREFIX)) {
    return decodeBase64Url(normalized.slice(BASE64_PREFIX.length));
  }
  return normalized;
}

function resolveBaseCookieName(name: string) {
  const match = name.match(CHUNK_SUFFIX_REGEX);
  return match ? match[1] ?? name : name;
}

function resolveChunkIndex(name: string) {
  const match = name.match(CHUNK_SUFFIX_REGEX);
  if (!match) return -1;
  const parsed = Number.parseInt(match[2] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

function combineCookieChunks(cookies: CookieLike[], storageKey: string) {
  const exact = cookies.find((cookie) => cookie.name === storageKey);
  if (exact?.value) return exact.value;

  const chunks = cookies
    .filter((cookie) => resolveBaseCookieName(cookie.name) === storageKey)
    .map((cookie) => ({
      index: resolveChunkIndex(cookie.name),
      value: cookie.value,
    }))
    .filter((cookie) => cookie.index >= 0)
    .sort((left, right) => left.index - right.index);

  if (chunks.length === 0) return null;
  for (let index = 0; index < chunks.length; index += 1) {
    if (chunks[index]?.index !== index) return null;
  }
  return chunks.map((cookie) => cookie.value).join("");
}

function parseSessionRecord(value: string | null) {
  if (!value) return null;
  const decoded = decodeCookieValue(value);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as JsonRecord;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function resolveUserIdFromSessionRecord(sessionRecord: JsonRecord | null) {
  if (!sessionRecord || typeof sessionRecord !== "object") return null;
  const sessionUser =
    sessionRecord.user && typeof sessionRecord.user === "object"
      ? (sessionRecord.user as JsonRecord)
      : null;
  const sessionUserId =
    typeof sessionUser?.id === "string" && sessionUser.id.trim()
      ? sessionUser.id.trim()
      : null;
  if (sessionUserId) return sessionUserId;

  const accessToken =
    typeof sessionRecord.access_token === "string"
      ? sessionRecord.access_token.trim()
      : "";
  if (!accessToken) return null;

  const jwtPayload = decodeJwtPayload(accessToken);
  return typeof jwtPayload?.sub === "string" && jwtPayload.sub.trim()
    ? jwtPayload.sub.trim()
    : null;
}

function decodeJwtPayload(accessToken: string) {
  const parts = String(accessToken || "").trim().split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    return JSON.parse(decodeBase64Url(parts[1]) ?? "") as JsonRecord;
  } catch {
    return null;
  }
}

function resolveAccessTokenFromCookies(
  cookies: CookieLike[],
  expectedUserId: string | null,
) {
  return resolveCookieSessionIdentity(cookies, expectedUserId)?.accessToken ?? null;
}

function resolveCookieSessionIdentity(
  cookies: CookieLike[],
  expectedUserId: string | null,
) {
  const storageKeys = Array.from(
    new Set(
      cookies
        .map((cookie) => resolveBaseCookieName(cookie.name))
        .filter((name) => name.includes("auth-token")),
    ),
  );
  let fallbackIdentity: { accessToken: string; userId: string | null } | null = null;

  for (const storageKey of storageKeys) {
    const sessionRecord = parseSessionRecord(combineCookieChunks(cookies, storageKey));
    if (!sessionRecord) continue;
    const accessToken =
      typeof sessionRecord.access_token === "string"
        ? sessionRecord.access_token.trim()
        : "";
    if (!accessToken) continue;

    const candidateUserId = resolveUserIdFromSessionRecord(sessionRecord);
    const identity = { accessToken, userId: candidateUserId };

    if (!fallbackIdentity) fallbackIdentity = identity;
    if (!expectedUserId || (candidateUserId && candidateUserId === expectedUserId)) {
      return identity;
    }
  }

  return fallbackIdentity;
}

function normalizeErrorMessage(error: unknown) {
  if (!error) return "";
  if (error instanceof Error) return error.message.trim().toLowerCase();
  if (typeof error === "string") return error.trim().toLowerCase();
  if (typeof error === "object") {
    const record = error as JsonRecord;
    for (const key of ["message", "details", "error", "error_description"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim().toLowerCase();
      }
    }
  }
  return String(error).trim().toLowerCase();
}

function isRecoverableSessionVerificationError(error: unknown) {
  const message = normalizeErrorMessage(error);
  if (!message) return false;
  return [
    "auth session missing",
    "session from session_id claim in jwt does not exist",
    "session does not exist",
    "session not found",
  ].some((marker) => message.includes(marker));
}

function resolveTrustedSessionIdentity(session: unknown): TrustedSessionIdentity | null {
  if (!session || typeof session !== "object") return null;
  const record = session as JsonRecord;
  const accessToken =
    typeof record.access_token === "string" ? record.access_token.trim() : "";
  if (!accessToken) return null;

  const user =
    record.user && typeof record.user === "object"
      ? (record.user as JsonRecord)
      : null;
  const userId = typeof user?.id === "string" ? user.id.trim() : "";
  if (!user || !userId) return null;

  const payload = decodeJwtPayload(accessToken);
  const subject = typeof payload?.sub === "string" ? payload.sub.trim() : "";
  if (subject && subject !== userId) return null;

  const expRaw = payload?.exp;
  const exp =
    typeof expRaw === "number"
      ? expRaw
      : typeof expRaw === "string"
        ? Number.parseInt(expRaw, 10)
        : Number.NaN;
  if (Number.isFinite(exp) && exp > 0 && exp * 1000 <= Date.now()) {
    return null;
  }

  return {
    accessToken,
    user: user as JsonRecord & { id: string },
  };
}

function createNoopServerClient(): SupabaseServerClient {
  return {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
      exchangeCodeForSession: async () => ({
        data: { session: null, user: null },
        error: null,
      }),
      signOut: async () => ({ error: null }),
    },
  } as unknown as SupabaseServerClient;
}

async function verifyUserFromAccessToken(
  accessToken: string,
  options: { allowCookieSet?: boolean } = {},
) {
  const client = createServerClient({ ...options, accessToken });
  let supabaseUrl = "";
  let supabaseAnonKey = "";
  try {
    const config = getPublicConfig();
    supabaseUrl = config.supabaseUrl;
    supabaseAnonKey = config.supabaseAnonKey;
  } catch {
    return {
      client,
      user: null,
      error: new Error("supabase_config_missing"),
    };
  }

  try {
    const response = await fetch(`${supabaseUrl.replace(/\/+$/g, "")}/auth/v1/user`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        apikey: supabaseAnonKey,
      },
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => null)) as JsonRecord | null;
    if (!response.ok) {
      const message =
        (typeof payload?.msg === "string" && payload.msg) ||
        (typeof payload?.error_description === "string" && payload.error_description) ||
        (typeof payload?.error === "string" && payload.error) ||
        (typeof payload?.message === "string" && payload.message) ||
        `authenticated_user_required (${response.status})`;
      return {
        client,
        user: null,
        error: new Error(message),
      };
    }

    return {
      client,
      user: payload,
      error: null,
    };
  } catch (error) {
    return {
      client,
      user: null,
      error:
        error instanceof Error ? error : new Error("authenticated_user_required"),
    };
  }
}

export function createServerClient(
  options: { allowCookieSet?: boolean; accessToken?: string | null } = {}
) {
  const cookieStorePromise = cookies();
  const { allowCookieSet = true, accessToken = null } = options;
  let supabaseUrl = "";
  let supabaseAnonKey = "";
  try {
    const config = getPublicConfig();
    supabaseUrl = config.supabaseUrl;
    supabaseAnonKey = config.supabaseAnonKey;
  } catch {
    return createNoopServerClient();
  }
  type CookieToSet = { name: string; value: string; options: CookieOptions };

  return createSupabaseServerClient(supabaseUrl, supabaseAnonKey, {
    db: { schema: "api" },
    cookieEncoding: "base64url",
    global: accessToken
      ? {
          headers: {
            authorization: `Bearer ${accessToken}`,
          },
        }
      : undefined,
    cookies: {
      async getAll() {
        const cookieStore = await cookieStorePromise;
        return cookieStore.getAll();
      },
      async setAll(cookiesToSet: CookieToSet[]) {
        if (!allowCookieSet) return;
        const cookieStore = await cookieStorePromise;
        cookiesToSet.forEach(({ name, value, options }) => {
          cookieStore.set(name, value, options);
        });
      },
    },
  });
}

export async function getVerifiedUser(
  options: { allowCookieSet?: boolean } = {}
) {
  const client = createServerClient(options);
  const { data: sessionData } = await client.auth.getSession();
  const trustedSession = resolveTrustedSessionIdentity(sessionData?.session ?? null);
  let { data, error } = await client.auth.getUser(trustedSession?.accessToken);
  let user = data?.user ?? null;

  if (!user || error) {
    const cookieStore = await cookies();
    const accessToken = resolveAccessTokenFromCookies(
      cookieStore.getAll().map((cookie) => ({ name: cookie.name, value: cookie.value })),
      null,
    );
    if (accessToken) {
      const tokenResult = await verifyUserFromAccessToken(accessToken, options);
      user = tokenResult.user;
      error = tokenResult.error;
      if (user && !error) {
        return {
          client: tokenResult.client,
          user,
          error: null,
        };
      }
    }
  }

  if ((!user || error) && trustedSession && isRecoverableSessionVerificationError(error)) {
    return {
      client,
      user: trustedSession.user,
      error: null,
    };
  }

  return {
    client,
    user,
    error: error ?? (user ? null : new Error("authenticated_user_required")),
  };
}

export async function getVerifiedAccessToken(
  options: { allowCookieSet?: boolean } = {}
) {
  const client = createServerClient(options);
  const cookieStore = await cookies();
  const cookieValues = cookieStore
    .getAll()
    .map((cookie) => ({ name: cookie.name, value: cookie.value }));
  const cookieIdentity = resolveCookieSessionIdentity(cookieValues, null);

  let sessionError: unknown = null;
  let trustedSession: TrustedSessionIdentity | null = null;
  let accessToken = cookieIdentity?.accessToken ?? null;
  let expectedUserId = cookieIdentity?.userId ?? null;

  if (!accessToken) {
    // Capture the session token before user verification. On server renders this
    // avoids false auth misses when later verification paths mutate in-memory
    // auth state but the session remains valid for the request.
    const { data: sessionData, error } = await client.auth.getSession();
    sessionError = error;
    const session = sessionData?.session ?? null;
    trustedSession = resolveTrustedSessionIdentity(session);
    accessToken = session?.access_token ?? trustedSession?.accessToken ?? null;
    expectedUserId = session?.user?.id ?? trustedSession?.user.id ?? null;

    if (!accessToken) {
      return {
        client,
        user: null,
        accessToken: null,
        error: sessionError instanceof Error ? sessionError : new Error("verified_access_token_required"),
      };
    }
  }

  // Reuse the request-scoped server client first so cookie-backed verification
  // can succeed without allocating a second auth client or mutating cookies.
  let verificationResult = await client.auth.getUser(accessToken).then((
    result: Awaited<ReturnType<SupabaseServerClient["auth"]["getUser"]>>
  ) => ({
    client,
    user: result.data?.user ?? null,
    error: result.error,
  }));

  if (!verificationResult.user || verificationResult.error) {
    verificationResult = await verifyUserFromAccessToken(accessToken, options);
  }

  const user = verificationResult.user;
  const userError = verificationResult.error;

  if (!user || userError) {
    if (
      trustedSession &&
      trustedSession.accessToken === accessToken &&
      isRecoverableSessionVerificationError(userError)
    ) {
      return {
        client,
        user: trustedSession.user,
        accessToken,
        error: null,
      };
    }
    return {
      client: verificationResult.client,
      user: null,
      accessToken: null,
      error: userError ?? new Error("authenticated_user_required"),
    };
  }

  if (expectedUserId && expectedUserId !== user.id) {
    return {
      client,
      user: null,
      accessToken: null,
      error: new Error("verified_access_token_user_mismatch"),
    };
  }

  return {
    client: verificationResult.client,
    user,
    accessToken,
    error: null,
  };
}
