import { expect, type Page } from "@playwright/test";
import { isStrictE2EEnv } from "./env";

type RuntimeCapture = {
  pageErrors: string[];
  consoleErrors: string[];
  dispose: () => void;
};

const BLOCKED_RUNTIME_PATTERNS = [
  /resource not available/i,
  /route missing from navigation/i,
  /no rows available/i,
  /missing capability/i,
  /requires .* capability/i,
];

export function isNoiseRuntimeConsoleMessage(
  message: string,
  options?: { locationUrl?: string; pageUrl?: string; allowOpaqueLocal503?: boolean }
) {
  const normalized = message.trim().toLowerCase();
  const locationUrl = String(options?.locationUrl ?? "")
    .trim()
    .toLowerCase();
  const pageUrl = String(options?.pageUrl ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  if (normalized.includes("download the react devtools")) return true;
  if (normalized.includes("failed to fetch rsc payload")) return true;
  if (normalized.includes("vercel.live/_next-live/feedback/feedback.js")) return true;

  const cspViolation =
    normalized.includes("content security policy directive") &&
    normalized.includes("script-src");
  if (cspViolation && (normalized.includes("vercel.live") || locationUrl.includes("vercel.live"))) {
    return true;
  }

  const generic404 = normalized.includes(
    "failed to load resource: the server responded with a status of 404"
  );
  if (generic404 && locationUrl.includes("vercel.live/_next-live/feedback/feedback.js")) {
    return true;
  }

  const generic401 = normalized.includes(
    "failed to load resource: the server responded with a status of 401"
  );
  if (generic401 && locationUrl.includes("/api/ui-event")) {
    return true;
  }

  const generic503 = normalized.includes(
    "failed to load resource: the server responded with a status of 503"
  );
  const localNextStaticAsset =
    /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/_next\/static\//.test(
      locationUrl
    );
  const localPage =
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(pageUrl);
  if (generic503 && !isStrictE2EEnv()) {
    if (localNextStaticAsset) {
      return true;
    }
    if (options?.allowOpaqueLocal503 && localPage) {
      return true;
    }
  }
  return false;
}

function isBlockedRuntimeFailure(error: unknown) {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return false;
  return BLOCKED_RUNTIME_PATTERNS.some((pattern) => pattern.test(message));
}

export function captureRuntimeErrors(
  page: Page,
  options?: { allowOpaqueLocal503?: boolean }
): RuntimeCapture {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  const onPageError = (error: Error) => {
    const message = error?.message || String(error);
    const stack = (error as Error | undefined)?.stack;
    if (stack && stack.trim() && !stack.includes(message)) {
      pageErrors.push(`${message}\n${stack}`);
      return;
    }
    pageErrors.push(stack?.trim() ? stack : message);
  };

  const onConsole = (msg: any) => {
    try {
      if (msg.type?.() !== "error") return;
      const text = msg.text?.() ?? "";
      const locationUrl = String(msg.location?.()?.url ?? "");
      const pageUrl = String(page.url?.() ?? "");
      if (
        isNoiseRuntimeConsoleMessage(text, {
          locationUrl,
          pageUrl,
          allowOpaqueLocal503: options?.allowOpaqueLocal503,
        })
      ) {
        return;
      }
      consoleErrors.push(text);
    } catch {
      // ignore
    }
  };

  page.on("pageerror", onPageError);
  page.on("console", onConsole);

  return {
    pageErrors,
    consoleErrors,
    dispose: () => {
      page.off("pageerror", onPageError);
      page.off("console", onConsole);
    },
  };
}

export async function expectNoRuntimeErrors(
  capture: RuntimeCapture,
  options?: { label?: string }
) {
  const label = options?.label ?? "runtime";
  expect(
    capture.pageErrors,
    `${label}: page errors: ${capture.pageErrors.join(" | ")}`
  ).toEqual([]);
  expect(
    capture.consoleErrors,
    `${label}: console errors: ${capture.consoleErrors.join(" | ")}`
  ).toEqual([]);
}

export async function runWithRuntimeErrors<T>(
  page: Page,
  options: { label?: string } | undefined,
  fn: (capture: RuntimeCapture) => Promise<T>
): Promise<T> {
  const capture = captureRuntimeErrors(page);

  try {
    let result: T | undefined;
    let thrown: unknown;

    try {
      result = await fn(capture);
    } catch (error) {
      thrown = error;
    }

    let runtimeError: unknown;
    try {
      await expectNoRuntimeErrors(capture, options);
    } catch (error) {
      runtimeError = error;
    }

    if (thrown && runtimeError) {
      if (isBlockedRuntimeFailure(thrown)) {
        throw thrown;
      }
      throw new AggregateError(
        [thrown, runtimeError],
        `${options?.label ?? "runtime"}: test failed with runtime errors`
      );
    }
    if (runtimeError) throw runtimeError;
    if (thrown) throw thrown;

    return result as T;
  } finally {
    capture.dispose();
  }
}
