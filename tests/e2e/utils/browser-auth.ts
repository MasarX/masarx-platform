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

function toPlaywrightCookie(surfaceOrigin: string, cookie: BrowserAuthCookie) {
  const expires =
    typeof cookie.options.maxAge === "number" && cookie.options.maxAge > 0
      ? Math.floor(Date.now() / 1000) + cookie.options.maxAge
      : undefined;
  const cookieUrl = new URL(cookie.options.path ?? "/", surfaceOrigin).toString();

  return {
    name: cookie.name,
    value: cookie.value,
    url: cookieUrl,
    httpOnly: cookie.options.httpOnly ?? false,
    sameSite: normalizeSameSite(cookie.options.sameSite),
    secure: cookie.options.secure ?? surfaceOrigin.startsWith("https://"),
    ...(typeof expires === "number" ? { expires } : null),
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
    cookies.map((cookie) => toPlaywrightCookie(surfaceOrigin, cookie))
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
    cookies: cookies.map((cookie) => toPlaywrightCookie(surfaceOrigin, cookie)),
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
