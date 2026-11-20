import type { Page } from "@playwright/test";
import {
  createAuthedSupabaseBrowserCookies,
  createAuthedSupabaseClient,
  type BrowserAuthCookie,
} from "./supabase";

function normalizeSameSite(
  value: string | undefined
): "Lax" | "None" | "Strict" | undefined {
  switch ((value ?? "").trim().toLowerCase()) {
    case "lax":
      return "Lax";
    case "none":
      return "None";
    case "strict":
      return "Strict";
    default:
      return undefined;
  }
}

function toStorageCookie(surfaceOrigin: string, cookie: BrowserAuthCookie) {
  const surface = new URL(surfaceOrigin);
  const path = cookie.options.path ?? "/";
  const scope = new URL(path, surface.origin);
  if (!path.startsWith("/") || scope.origin !== surface.origin) {
    throw new Error("Browser auth cookie path must stay on the application origin.");
  }
  const expires =
    typeof cookie.options.maxAge === "number" && cookie.options.maxAge > 0
      ? Math.floor(Date.now() / 1000) + cookie.options.maxAge
      : -1;

  return {
    name: cookie.name,
    value: cookie.value,
    domain: surface.hostname,
    path: scope.pathname,
    httpOnly: cookie.options.httpOnly ?? false,
    sameSite: normalizeSameSite(cookie.options.sameSite) ?? ("Lax" as const),
    secure: cookie.options.secure ?? surface.protocol === "https:",
    expires,
  };
}

export async function seedBrowserAuthSession(params: {
  page: Page;
  surfaceOrigin: string;
  email: string;
  password: string;
  label?: string;
}) {
  const { page, surfaceOrigin, email, password, label } = params;
  const cookies = await createAuthedSupabaseBrowserCookies({
    email,
    password,
    label,
  });
  await page.context().addCookies(
    cookies.map((cookie) => toStorageCookie(surfaceOrigin, cookie))
  );
}

export async function createBrowserAuthStorageState(params: {
  surfaceOrigin: string;
  email: string;
  password: string;
  label?: string;
}) {
  const { surfaceOrigin, email, password, label } = params;
  const cookies = await createAuthedSupabaseBrowserCookies({
    email,
    password,
    label,
  });
  return {
    cookies: cookies.map((cookie) => toStorageCookie(surfaceOrigin, cookie)),
    origins: [],
  };
}

export async function createConsoleV2AuthStorageState(params: {
  surfaceOrigin: string;
  email: string;
  password: string;
  label?: string;
}) {
  const { surfaceOrigin, email, password, label } = params;
  const supabase = await createAuthedSupabaseClient({ email, password, label });
  const { data, error } = await supabase.auth.getSession();
  if (error || !data?.session) {
    throw new Error(
      `Console V2 auth storage state failed for ${label ?? email}: ${
        error?.message ?? "no session"
      }`
    );
  }

  return {
    cookies: [],
    origins: [
      {
        origin: new URL(surfaceOrigin).origin,
        localStorage: [
          {
            name: "masarx-console-v2-auth",
            value: JSON.stringify(data.session),
          },
        ],
      },
    ],
  };
}
