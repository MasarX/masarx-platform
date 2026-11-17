type CookieLike = {
  name: string;
  value: string;
};

export type SupabaseSessionIdentity = {
  storageKey: string;
  email: string | null;
  userId: string | null;
};

const BASE64_PREFIX = "base64-";
const CHUNK_SUFFIX_REGEX = /^(.*)\.(\d+)$/;

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function decodeCookieValue(value: string) {
  if (value.startsWith(BASE64_PREFIX)) {
    try {
      return decodeBase64Url(value.slice(BASE64_PREFIX.length));
    } catch {
      return null;
    }
  }
  return value;
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
  if (exact?.value) {
    return exact.value;
  }

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
    if (chunks[index]?.index !== index) {
      return null;
    }
  }

  return chunks.map((cookie) => cookie.value).join("");
}

function parseJsonRecord(value: string | null) {
  if (!value) return null;
  const decoded = decodeCookieValue(value);
  if (!decoded) return null;

  try {
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(accessToken: string | null | undefined) {
  const token = accessToken?.trim() ?? "";
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;

  try {
    const parsed = JSON.parse(decodeBase64Url(parts[1])) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function resolveCandidateEmail(params: {
  sessionRecord: Record<string, unknown>;
  userRecord: Record<string, unknown> | null;
}) {
  const sessionUser =
    params.sessionRecord.user && typeof params.sessionRecord.user === "object"
      ? (params.sessionRecord.user as Record<string, unknown>)
      : null;
  const userRecord =
    params.userRecord?.user && typeof params.userRecord.user === "object"
      ? (params.userRecord.user as Record<string, unknown>)
      : params.userRecord;
  const jwtPayload = decodeJwtPayload(
    typeof params.sessionRecord.access_token === "string"
      ? params.sessionRecord.access_token
      : null
  );
  const sessionUserMetadata =
    sessionUser?.user_metadata && typeof sessionUser.user_metadata === "object"
      ? (sessionUser.user_metadata as Record<string, unknown>)
      : null;
  const userRecordMetadata =
    userRecord?.user_metadata && typeof userRecord.user_metadata === "object"
      ? (userRecord.user_metadata as Record<string, unknown>)
      : null;

  const candidate =
    sessionUser?.email ??
    userRecord?.email ??
    jwtPayload?.email ??
    sessionUserMetadata?.email ??
    userRecordMetadata?.email ??
    null;

  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function resolveCandidateUserId(params: {
  sessionRecord: Record<string, unknown>;
  userRecord: Record<string, unknown> | null;
}) {
  const sessionUser =
    params.sessionRecord.user && typeof params.sessionRecord.user === "object"
      ? (params.sessionRecord.user as Record<string, unknown>)
      : null;
  const userRecord =
    params.userRecord?.user && typeof params.userRecord.user === "object"
      ? (params.userRecord.user as Record<string, unknown>)
      : params.userRecord;
  const jwtPayload = decodeJwtPayload(
    typeof params.sessionRecord.access_token === "string"
      ? params.sessionRecord.access_token
      : null
  );

  const candidate = sessionUser?.id ?? userRecord?.id ?? jwtPayload?.sub ?? null;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

export function extractSupabaseSessionIdentities(cookies: CookieLike[]) {
  const storageKeys = Array.from(
    new Set(cookies.map((cookie) => resolveBaseCookieName(cookie.name)))
  );

  const sessionRecords = new Map<string, Record<string, unknown>>();
  const userRecords = new Map<string, Record<string, unknown>>();

  storageKeys.forEach((storageKey) => {
    const record = parseJsonRecord(combineCookieChunks(cookies, storageKey));
    if (!record) return;

    if (
      typeof record.access_token === "string" ||
      typeof record.refresh_token === "string"
    ) {
      sessionRecords.set(storageKey, record);
      return;
    }

    const userCandidate =
      record.user && typeof record.user === "object" ? record : null;
    if (userCandidate) {
      userRecords.set(storageKey, userCandidate);
    }
  });

  return Array.from(sessionRecords.entries()).map(([storageKey, sessionRecord]) => {
    const userRecord = userRecords.get(`${storageKey}-user`) ?? null;
    return {
      storageKey,
      email: resolveCandidateEmail({ sessionRecord, userRecord }),
      userId: resolveCandidateUserId({ sessionRecord, userRecord }),
    } satisfies SupabaseSessionIdentity;
  });
}

export function findSupabaseSessionIdentity(
  cookies: CookieLike[],
  email: string
) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return null;

  return (
    extractSupabaseSessionIdentities(cookies).find(
      (identity) => identity.email?.trim().toLowerCase() === normalizedEmail
    ) ?? null
  );
}
