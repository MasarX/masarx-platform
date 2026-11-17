const TOKEN_PATH = "/auth/v1/token";

export type PasswordGrantRequestMatchInput = {
  method?: string;
  url?: string;
  postData?: string | null;
  email?: string;
};

function normalizeLower(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function hasPasswordGrant(urlRaw: string, postDataRaw: string): boolean {
  const normalizedUrl = String(urlRaw || "");
  const normalizedBody = String(postDataRaw || "");
  if (!normalizedUrl.includes(TOKEN_PATH)) return false;
  try {
    const parsed = new URL(normalizedUrl);
    const grantType = normalizeLower(parsed.searchParams.get("grant_type"));
    if (grantType === "password") return true;
  } catch {
    // Ignore URL parsing issues and rely on fallback matchers.
  }

  if (/(^|[?&])grant_type=password(?:&|$)/i.test(normalizedUrl)) return true;
  if (/\"grant_type\"\s*:\s*\"password\"/i.test(normalizedBody)) return true;
  return /(^|[&])grant_type=password(?:&|$)/i.test(normalizedBody);
}

function hasMatchingEmail(postDataRaw: string, expectedEmail: string): boolean {
  const postData = String(postDataRaw || "");
  const email = normalizeLower(expectedEmail);
  if (!email) return true;

  if (normalizeLower(postData).includes(email)) return true;

  try {
    const parsed = JSON.parse(postData);
    if (normalizeLower(parsed?.email) === email) return true;
  } catch {
    // Not JSON.
  }

  try {
    const params = new URLSearchParams(postData);
    if (normalizeLower(params.get("email")) === email) return true;
  } catch {
    // Not form-encoded.
  }

  return false;
}

export function isPasswordGrantTokenRequest(
  input: PasswordGrantRequestMatchInput
): boolean {
  const method = normalizeLower(input?.method);
  if (method !== "post") return false;

  const url = String(input?.url || "");
  const postData = String(input?.postData || "");
  if (!hasPasswordGrant(url, postData)) return false;

  const expectedEmail = normalizeLower(input?.email);
  if (!expectedEmail) return true;
  return hasMatchingEmail(postData, expectedEmail);
}

export function summarizeAuthErrorBody(
  responseBody: string,
  maxLen = 220
): string {
  const raw = String(responseBody || "").trim();
  if (!raw) return "";

  try {
    const parsed = JSON.parse(raw);
    const code = String(parsed?.error_code || parsed?.code || "").trim();
    const message = String(
      parsed?.msg || parsed?.message || parsed?.error_description || parsed?.error || ""
    ).trim();
    const combined = [code, message].filter(Boolean).join(": ");
    if (combined) return combined.slice(0, maxLen);
  } catch {
    // Not JSON.
  }

  return raw.slice(0, maxLen);
}
