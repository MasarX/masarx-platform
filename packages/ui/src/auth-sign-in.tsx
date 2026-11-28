"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createBrowserClient } from "@masarx/auth/browser";
import { z } from "zod";
import { getUiDefaults } from "@masarx/config";
import { useTranslations } from "next-intl";
import { Button } from "./button";
import { AuthMfa } from "./auth-mfa";
import { Form, FormField, useZodForm } from "./form";
import { Input } from "./input";
import { normalizeAppHref, normalizeBasePath, stripBasePath } from "./navigation-paths";
import { RadioGroup, RadioGroupItem } from "./radio-group";
import { buildHref } from "./url";
import { formatUiError, getUiErrorMessage } from "./utils";
import {
  createRequestId,
  reportClientError,
  reportUiEvent,
  setRequestId
} from "./reporting";
import { resolveSafeAppBasePath } from "./url-guard";

type AuthMethod = "magic_link" | "password";

export type AuthSignInProps = {
  appLabel: string;
  methods?: string[];
  callbackPath?: string;
  appBasePath?: string;
  testIdPrefix?: string;
};

const uiDefaults = getUiDefaults();
const ALLOWED_METHODS = new Set<AuthMethod>(["magic_link", "password"]);
const FALLBACK_METHODS = uiDefaults.authMethods;
const METHOD_LABELS = uiDefaults.authMethodLabels;

const buildAuthSchema = (t: (key: string) => string) =>
  z
    .object({
      method: z.enum(["magic_link", "password"]),
      email: z.string().email(t("errors.email")),
      password: z.string().optional(),
    })
    .superRefine((values, ctx) => {
      if (values.method === "password" && !values.password?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["password"],
          message: t("errors.passwordRequired"),
        });
      }
    });

export function AuthMfaSignIn() {
  const router = useRouter();
  const supabase = React.useMemo(() => createBrowserClient(), []);
  return (
    <AuthMfa
      mfa={supabase.auth.mfa}
      onVerified={() => router.refresh()}
      onSignOut={async () => {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
        router.refresh();
      }}
    />
  );
}

function filterAuthMethods(methods: string[]) {
  const normalized = methods
    .map((method) => method.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(normalized)).filter((method) =>
    ALLOWED_METHODS.has(method as AuthMethod)
  ) as AuthMethod[];
}

const DEFAULT_METHODS = filterAuthMethods(FALLBACK_METHODS);

function normalizeMethods(methods?: string[]): AuthMethod[] {
  if (!methods || methods.length === 0) return DEFAULT_METHODS;
  const unique = filterAuthMethods(methods);
  return unique.length > 0 ? unique : DEFAULT_METHODS;
}

function buildReturnPath(pathname: string, searchParams: URLSearchParams) {
  const params = new URLSearchParams(searchParams.toString());
  params.delete("error");
  params.delete("code");
  params.delete("next");
  return buildHref(pathname, params);
}

/**
 * Sign-in form with email link and password modes.
 */
export function AuthSignIn({
  appLabel,
  methods,
  callbackPath = "/auth/callback",
  appBasePath,
  testIdPrefix = "auth",
}: AuthSignInProps) {
  const t = useTranslations("ui.auth.signIn");
  const authSchema = React.useMemo(() => buildAuthSchema(t), [t]);
  const resolvedMethods = React.useMemo(() => normalizeMethods(methods), [methods]);
  const form = useZodForm(authSchema, {
    defaultValues: {
      method: resolvedMethods[0] ?? "magic_link",
      email: "",
      password: "",
    },
  });
  const [status, setStatus] = React.useState<"idle" | "loading" | "sent" | "error">(
    "idle"
  );
  const [message, setMessage] = React.useState<string | null>(null);
  const pathname = usePathname() ?? "/";
  const safeBasePath = React.useMemo(
    () => resolveSafeAppBasePath(appBasePath ?? ""),
    [appBasePath]
  );
  const resolvedPathname = stripBasePath(pathname, safeBasePath ?? undefined);
  const searchParams = useSearchParams();
  const router = useRouter();
  const supabase = React.useMemo(() => createBrowserClient(), []);
  const isSubmitting = React.useRef(false);

  React.useEffect(() => {
    const nextMethod = resolvedMethods[0] ?? "magic_link";
    if (!resolvedMethods.includes(form.getValues("method") as AuthMethod)) {
      form.setValue("method", nextMethod);
    }
  }, [form, resolvedMethods]);

  React.useEffect(() => {
    const errorMessage = searchParams?.get("error");
    if (errorMessage) {
      setStatus("error");
      setMessage(formatUiError(errorMessage, t("errors.signInFailed")));
    }
  }, [searchParams]);

  const returnTo = React.useMemo(() => {
    if (!searchParams) return resolvedPathname;
    return buildReturnPath(resolvedPathname, searchParams);
  }, [resolvedPathname, searchParams]);

  const redirectTo = React.useMemo(() => {
    if (typeof window === "undefined") return callbackPath;
    const url = new URL(callbackPath, window.location.origin);
    url.searchParams.set("next", returnTo);
    return url.toString();
  }, [callbackPath, returnTo]);

  const method = form.watch("method") as AuthMethod;
  const email = form.watch("email");
  const password = form.watch("password");
  const hasEmail = email.trim().length > 0;
  const hasPassword = Boolean(password?.trim());
  const canSubmit =
    status !== "loading" &&
    hasEmail &&
    (method !== "password" || hasPassword);
  const isMountedRef = React.useRef(false);
  const signInRootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    isMountedRef.current = true;
    signInRootRef.current?.setAttribute("data-hydrated", "true");
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleSubmit = async (values: z.infer<typeof authSchema>) => {
    if (isSubmitting.current) {
      return;
    }

    setMessage(null);
    const requestId = createRequestId();
    isSubmitting.current = true;
    setStatus("loading");
    setRequestId(requestId);
    reportUiEvent({
      type: "ui.auth.signin.submit.start",
      timestamp: new Date().toISOString(),
      context: "AuthSignIn",
      name: "submit",
      digest: appLabel,
      meta: {
        method: values.method,
        hasPassword,
      },
      requestId,
    });

    let nextStatus: "idle" | "sent" | "error" | null = null;
    let nextMessage: string | null = null;

    const setFailure = (error: unknown) => {
      nextStatus = "error";
      nextMessage = formatUiError(error, t("errors.signInFailed"));
      reportClientError(
        error instanceof Error ? error : new Error(getUiErrorMessage(error) ?? t("errors.signInFailed")),
        {
          context: "AuthSignIn",
          digest: appLabel,
          requestId,
        }
      );
      reportUiEvent({
        type: "ui.auth.signin.submit.error",
        timestamp: new Date().toISOString(),
        context: "AuthSignIn",
        name: "submit.error",
        message: nextMessage ?? t("errors.signInFailed"),
        digest: appLabel,
        meta: {
          method: values.method,
        },
        requestId,
      });
    };

    const setSuccess = (nextStatusValue: "idle" | "sent", successMessage?: string) => {
      nextStatus = nextStatusValue;
      nextMessage = successMessage ?? null;
      reportUiEvent({
        type: "ui.auth.signin.submit.success",
        timestamp: new Date().toISOString(),
        context: "AuthSignIn",
        name:
          nextStatusValue === "sent"
            ? "magic_link.sent"
            : "password.signed_in",
        digest: appLabel,
        meta: {
          method: values.method,
        },
        requestId,
      });
    };

    try {
      if (values.method === "password") {
        const { error } = await supabase.auth.signInWithPassword({
          email: values.email,
          password: values.password ?? "",
        });
        if (error) {
          setFailure(error);
          return;
        }

        setSuccess("idle");
        const basePrefix = normalizeBasePath(safeBasePath ?? "");
        const nextHref = normalizeAppHref(
          `${basePrefix}${returnTo}`,
          safeBasePath || undefined
        );
        const strippedHref = stripBasePath(nextHref || returnTo, safeBasePath ?? undefined);
        router.replace(strippedHref || "/");
        router.refresh();
        return;
      }

      const callbackRedirect = new URL(redirectTo);
      callbackRedirect.searchParams.set("request_id", requestId);

      const { error } = await supabase.auth.signInWithOtp({
        email: values.email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: callbackRedirect.toString(),
        },
      });
      if (error) {
        setFailure(error);
        return;
      }

      setSuccess("sent", t("messages.linkSent"));
      return;
    } catch (error) {
      setFailure(error);
    } finally {
      setRequestId(undefined);
      isSubmitting.current = false;
      if (!isMountedRef.current) {
        return;
      }

      if (nextStatus === null) {
        nextStatus = "error";
        if (!nextMessage) {
          nextMessage = formatUiError(
            "Sign-in attempt failed unexpectedly",
            t("errors.signInFailed")
          );
        }
      }

      setStatus(nextStatus);
      if (nextMessage !== null) {
        setMessage(nextMessage);
      }
    }
  };

  return (
    <div
      ref={signInRootRef}
      className="space-y-6"
      data-testid={`${testIdPrefix}-sign-in`}
    >
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-sm uppercase tracking-[0.25em] text-ui-muted">
            {t("workflowFirst")}
          </div>
          <h1 className="mt-2 text-3xl font-semibold text-ui-ink">
            {t("title", { appLabel })}
          </h1>
          <p className="mt-2 text-base text-ui-muted">
            {t("description")}
          </p>
        </div>
      </div>
      <section className="rounded-xl border border-ui-border bg-ui-surface/70 p-6">
        <Form form={form} onSubmit={handleSubmit} className="space-y-4">
          {resolvedMethods.length > 1 ? (
            <div className="space-y-2 text-sm text-ui-ink">
              <div className="text-xs tracking-wide text-ui-muted">
                {t("methodLabel")}
              </div>
              <RadioGroup className="flex flex-wrap gap-3">
                {resolvedMethods.map((option) => (
                  <label
                    key={option}
                    className="flex items-center gap-2 rounded-full border border-ui-border bg-ui-surface/70 px-3 py-1 text-xs"
                  >
                    <RadioGroupItem
                      name="method"
                      value={option}
                      checked={method === option}
                      onChange={() => form.setValue("method", option)}
                    />
                    {METHOD_LABELS[option] ?? option}
                  </label>
                ))}
              </RadioGroup>
            </div>
          ) : null}
          <FormField
            name="email"
            label={t("emailLabel")}
            labelClassName="text-xs tracking-wide text-ui-muted"
            render={({ field, fieldId, describedBy, invalid }) => (
              <Input
                id={fieldId}
                type="email"
                autoComplete="email"
                placeholder={t("emailPlaceholder")}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...field}
              />
            )}
          />
          {method === "password" ? (
            <FormField
              name="password"
              label={t("passwordLabel")}
              labelClassName="text-xs tracking-wide text-ui-muted"
              render={({ field, fieldId, describedBy, invalid }) => (
                <Input
                  id={fieldId}
                  type="password"
                  autoComplete="current-password"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  {...field}
                />
              )}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!canSubmit}>
              {status === "loading" ? t("submitting") : t("submit")}
            </Button>
            <span className="text-xs text-ui-muted">
              {method === "password"
                ? t("passwordHint")
                : t("magicLinkHint")}
            </span>
          </div>
          {message ? (
            <div className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm">
              {message}
            </div>
          ) : null}
        </Form>
      </section>
    </div>
  );
}
