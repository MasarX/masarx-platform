import { createClient, type Session } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import {
  loadDemoContext,
  resolveUsableDemoPassword,
} from "../../e2e/utils/demo-accounts";

type DriverCredentials = {
  email: string;
  password: string;
};

type DriverAuthInput = DriverCredentials & {
  supabaseUrl: string;
  supabaseAnonKey: string;
  startUrl?: string;
};

function requireNonEmpty(value: string, label: string) {
  const resolved = value.trim();
  if (!resolved) {
    throw new Error(`[fieldops-driver-auth] Missing ${label}`);
  }
  return resolved;
}

function resolveSupabaseStorageKey(supabaseUrl: string) {
  const hostname = new URL(supabaseUrl).hostname;
  return `sb-${hostname.split(".")[0]}-auth-token`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function createDriverSession(input: DriverAuthInput) {
  const client = createClient(input.supabaseUrl, input.supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  let lastError: unknown = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const { data, error } = await withTimeout(
        client.auth.signInWithPassword({
          email: input.email,
          password: input.password,
        }),
        15_000,
        "signInWithPassword",
      );

      if (error) throw error;
      if (!data?.session) {
        throw new Error("signInWithPassword returned no session");
      }

      return data.session;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) =>
        setTimeout(resolve, 1_000 * (attempt + 1)),
      );
    }
  }

  throw new Error(
    `[fieldops-driver-auth] Failed to create driver session after retries: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function authenticateDriver(
  page: Page,
  credentials: DriverAuthInput,
): Promise<void> {
  const email = requireNonEmpty(credentials.email, "driver email");
  const password = requireNonEmpty(
    await resolveUsableDemoPassword({
      email,
      password: credentials.password,
    }),
    "driver password",
  );
  const supabaseUrl = requireNonEmpty(credentials.supabaseUrl, "Supabase URL");
  const supabaseAnonKey = requireNonEmpty(
    credentials.supabaseAnonKey,
    "Supabase anon key",
  );

  const session = await createDriverSession({
    email,
    password,
    supabaseUrl,
    supabaseAnonKey,
  });
  const storageKey = resolveSupabaseStorageKey(supabaseUrl);

  await page.addInitScript(
    ([authStorageKey, sessionValue]: [string, Session]) => {
      window.localStorage.setItem(authStorageKey, JSON.stringify(sessionValue));
    },
    [storageKey, session] as [string, Session],
  );

  await page.goto(credentials.startUrl || "/", { waitUntil: "domcontentloaded" });
}

export function resolveDriverCredentials(): DriverCredentials | null {
  const context = loadDemoContext();
  if (!context.available || !context.password) {
    return null;
  }

  const driver = context.users.find(
    (user) =>
      String(user.user_type || "")
        .trim()
        .toLowerCase() === "driver",
  );
  const email = String(driver?.email || "").trim();
  if (!email) {
    return null;
  }

  return {
    email,
    password: context.password,
  };
}
