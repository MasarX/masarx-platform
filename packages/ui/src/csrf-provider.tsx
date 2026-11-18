"use client";

import * as React from "react";
import { useCsrfToken, CSRF_HEADER_NAME } from "./csrf";

type CsrfContextValue = {
  /** The current CSRF token */
  token: string;
  /** Header name to attach in mutation requests */
  headerName: string;
};

const CsrfContext = React.createContext<CsrfContextValue>({
  token: "",
  headerName: CSRF_HEADER_NAME,
});

/**
 * Read the current CSRF context (token + header name).
 */
export function useCsrf(): CsrfContextValue {
  return React.useContext(CsrfContext);
}

/**
 * Provider that generates a CSRF token on mount and makes it available
 * to descendants via context. It also patches the global `fetch` to
 * automatically attach the CSRF header on same-origin mutation requests
 * (POST, PUT, PATCH, DELETE).
 */
export function CsrfProvider({ children }: { children: React.ReactNode }) {
  const token = useCsrfToken();

  // Patch global fetch once the token is available so all same-origin
  // mutation requests automatically include the CSRF header.
  React.useEffect(() => {
    if (!token) return;

    const originalFetch = window.fetch;

    const patchedFetch: typeof fetch = (input, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

      if (isMutation) {
        // Only attach to same-origin requests.
        let isSameOrigin = true;
        try {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : (input as Request).url;
          if (url.startsWith("http")) {
            isSameOrigin = new URL(url).origin === window.location.origin;
          }
        } catch {
          // Relative URLs are same-origin by definition.
        }

        if (isSameOrigin) {
          const headers = new Headers(init?.headers);
          if (!headers.has(CSRF_HEADER_NAME)) {
            headers.set(CSRF_HEADER_NAME, token);
          }
          return originalFetch(input, { ...init, headers });
        }
      }

      return originalFetch(input, init);
    };

    window.fetch = patchedFetch;

    return () => {
      // Restore only if we are still the active patch (prevents conflicts
      // when multiple providers are mounted/unmounted).
      if (window.fetch === patchedFetch) {
        window.fetch = originalFetch;
      }
    };
  }, [token]);

  const value = React.useMemo<CsrfContextValue>(
    () => ({ token, headerName: CSRF_HEADER_NAME }),
    [token]
  );

  return (
    <CsrfContext.Provider value={value}>
      {children}
    </CsrfContext.Provider>
  );
}
