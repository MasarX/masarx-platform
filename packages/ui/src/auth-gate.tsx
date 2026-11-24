import * as React from "react";
import { Section } from "./section";
import { AuthMfaSignIn, AuthSignIn } from "./auth-sign-in";
import { isMfaRequired } from "./auth-assurance";
import { ErrorReload } from "./error-reload";
import { buildTestId } from "./test-ids";
import { formatUiError, getUiErrorMessage } from "./utils";
import { createUiTranslator } from "./i18n";

type AuthGateProps = {
  appLabel: string;
  contextError?: unknown | null;
  children: React.ReactNode;
  testIdPrefix: string;
  authMethods?: string[];
  callbackPath?: string;
  appBasePath?: string;
  forceAuth?: boolean;
};

const AUTH_ERROR_MARKERS = [
  "authenticated",
  "authentication",
  "auth session",
  "authorization",
  "invalid jwt",
  "invalid refresh",
  "permission denied",
  "missing authorization",
  "missing token",
  "not authenticated",
  "unauthorized",
  "jwt",
];
const AUTH_ERROR_CODES = new Set(["PGRST301", "PGRST302", "401"]);
const CONTEXT_HINTS = [
  {
    markers: ["ui_me_v1", "public.users", "users"],
    key: "profile"
  },
  {
    markers: [
      "ui_navigation_v1",
      "ui_read_registry",
      "ui_read_registry_v1",
      "ui_command_registry_v1",
      "ui_table_views_v1",
      "ui_access_policy_v1",
      "access_control_policy"
    ],
    key: "registry"
  },
  {
    markers: [
      "fetch failed",
      "failed to fetch",
      "ecconnrefused",
      "enotfound",
      "network error",
      "networkerror"
    ],
    key: "network"
  }
];

function isAuthErrorMessage(message: string | null | undefined) {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return AUTH_ERROR_MARKERS.some((marker) => normalized.includes(marker));
}

function isAuthError(error: unknown, message: string | null | undefined) {
  if (isAuthErrorMessage(message)) return true;
  if (error && typeof error === "object") {
    const typed = error as {
      code?: string | number;
      status?: string | number;
      name?: string;
      details?: string;
    };
    if (typeof typed.details === "string" && isAuthErrorMessage(typed.details)) {
      return true;
    }
    if (typeof typed.name === "string" && typed.name.toLowerCase().includes("auth")) {
      return true;
    }
    const code = typed.code ? String(typed.code).toUpperCase() : null;
    if (code && AUTH_ERROR_CODES.has(code)) return true;
    const status = typed.status ? String(typed.status) : null;
    if (status === "401") return true;
  }
  return false;
}

function resolveContextHint(
  message: string | null,
  t: (key: string, values?: Record<string, string>) => string
) {
  if (!message) return null;
  const normalized = message.toLowerCase();
  for (const hint of CONTEXT_HINTS) {
    if (hint.markers.some((marker) => normalized.includes(marker))) {
      return t(`contextHints.${hint.key}`);
    }
  }
  return null;
}

/**
 * Authentication gate that renders context errors or sign-in flow.
 */
export function AuthGate({
  appLabel,
  contextError,
  children,
  testIdPrefix,
  authMethods,
  callbackPath,
  appBasePath,
  forceAuth,
}: AuthGateProps) {
  if (isMfaRequired(contextError)) {
    return (
      <Section>
        <AuthMfaSignIn />
      </Section>
    );
  }
  const t = createUiTranslator("ui.auth.gate");
  const contextMessage = getUiErrorMessage(contextError);
  const errorMessage = contextError
    ? formatUiError(contextError, t("contextError"))
    : null;
  if (!errorMessage && !forceAuth) {
    return <>{children}</>;
  }

  const authRequired =
    Boolean(forceAuth) || isAuthError(contextError, contextMessage);
  const testId = buildTestId(
    testIdPrefix,
    authRequired ? "auth-required" : "context-unavailable"
  );
  const title = authRequired
    ? t("authRequiredTitle", { appLabel })
    : t("contextUnavailableTitle");
  const diagnosis = authRequired ? t("authRequiredDiagnosis") : t("contextUnavailableDiagnosis");
  const action = authRequired
    ? t("authRequiredAction")
    : resolveContextHint(contextMessage, t) ??
      t("contextUnavailableAction");
  const details = errorMessage;

  return (
    <Section>
      <div data-testid={testId} className="space-y-2">
        <p className="text-sm text-ui-muted">{title}</p>
        <p className="text-xs text-ui-muted">
          {t("diagnosis", { diagnosis })}
        </p>
        <p className="text-xs text-ui-muted">
          {t("recommendedAction", { action })}
        </p>
        {!authRequired && details ? (
          <p className="text-xs text-ui-muted">
            {t("details", { details })}
          </p>
        ) : null}
      </div>
      {authRequired ? (
        <div className="mt-6">
          <AuthSignIn
            appLabel={appLabel}
            methods={authMethods}
            callbackPath={callbackPath}
            appBasePath={appBasePath}
            testIdPrefix={testId}
          />
        </div>
      ) : (
        <div className="mt-6">
          <ErrorReload />
        </div>
      )}
    </Section>
  );
}
