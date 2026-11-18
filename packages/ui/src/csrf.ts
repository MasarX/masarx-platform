"use client";

import { useCallback, useEffect, useState } from "react";

const CSRF_COOKIE_NAME = "masarx-csrf-token";
const CSRF_HEADER_NAME = "x-csrf-token";
const TOKEN_BYTE_LENGTH = 32;

/**
 * Generate a cryptographically random CSRF token, store it in a
 * same-site cookie, and return the token string.
 */
export function generateCsrfToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Store in a strict same-site cookie so it is automatically sent on
  // same-origin requests while remaining inaccessible to cross-origin pages.
  document.cookie = `${CSRF_COOKIE_NAME}=${token}; path=/; SameSite=Strict; Secure`;

  return token;
}

/**
 * Read the current CSRF token from the cookie jar.
 * Returns `null` when the cookie is not set.
 */
export function readCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${CSRF_COOKIE_NAME}=([^;]+)`)
  );
  return match?.[1] ?? null;
}

/**
 * Validate that a supplied token matches the value stored in the cookie.
 * This is a double-submit-cookie pattern: the cookie is sent automatically
 * by the browser and the token is sent as a header / hidden field.
 */
export function validateCsrfToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const expected = readCsrfToken();
  if (!expected) return false;
  return token === expected;
}

/**
 * React hook that returns the current CSRF token, generating one on mount
 * if it does not already exist.
 */
export function useCsrfToken(): string {
  const [token, setToken] = useState<string>("");

  useEffect(() => {
    const existing = readCsrfToken();
    if (existing) {
      setToken(existing);
    } else {
      setToken(generateCsrfToken());
    }
  }, []);

  const refresh = useCallback(() => {
    setToken(generateCsrfToken());
  }, []);

  // Re-expose refresh on the returned token via a hidden property is
  // unnecessary -- callers who need to rotate can import generateCsrfToken
  // directly.  The hook intentionally returns a plain string for simplicity.
  void refresh;

  return token;
}

export { CSRF_COOKIE_NAME, CSRF_HEADER_NAME };
