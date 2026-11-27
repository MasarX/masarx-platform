import { randomUUID } from "node:crypto";
import * as React from "react";
import type { Metadata } from "next";
import type { AbstractIntlMessages } from "next-intl";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import {
  AppShell,
  AuthGate,
  ContextStrip,
  NavigationNext,
  PageContainer,
  hasCapability,
  resolveCapabilitySet,
  localizeNavigation,
} from "@masarx/ui";
import {
  ErrorBoundary,
  ErrorReload,
  QueryProvider,
  ThemeProvider,
  UiNavigationProvider,
  ThemeToggle,
  ToastHost,
} from "@masarx/ui/client";
import { createUiServerClient } from "@masarx/api/server";
import {
  normalizeNavigation,
  normalizeUiScope,
  type UiMe,
  type UiNavigation,
} from "@masarx/api";
import { getVerifiedAccessToken } from "@masarx/auth";
import { getPublicConfig, getUiDefaults } from "@masarx/config";
import { MissingEnvNotice } from "./missing-env";
import { resolveLocaleDir } from "./i18n/direction";
import { UiTelemetryReporter } from "./ui-telemetry";
import { loadUiContextCached } from "./ui-context-cache";
import { appFontClassName } from "./fonts";
import { resolveSafeAppBasePath } from "../../packages/ui/src/url-guard";
import { resolveAppBasePath } from "./app-base-path";

export type AppKey = "console" | "portal";
export type AppAuthMode = "required" | "optional";
export type LoadMessages = (locale: string) => Promise<AbstractIntlMessages>;
type AppTranslator = ReturnType<typeof createTranslator<any>>;

function decodeJwtSubject(token: string | null) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as { sub?: unknown };
    return typeof parsed.sub === "string" && parsed.sub.trim() ? parsed.sub.trim() : null;
  } catch {
    return null;
  }
}

type AppContext = {
  appKey: AppKey;
  appBasePath: string;
  appName: string;
  config: ReturnType<typeof getPublicConfig> | null;
  configError: string | null;
  locale: string;
  isRtl: boolean;
  messages: AbstractIntlMessages;
  t: AppTranslator;
};

export type DefaultPageProps = {
  params?: unknown;
  searchParams?: unknown;
};

type DynamicPageProps<P> = {
  [K in keyof P]: K extends "params" | "searchParams" ? Promise<P[K]> : P[K];
};

export type AppContextWithConfig = AppContext & {
  config: NonNullable<AppContext["config"]>;
};

export type AppViewContextWithConfig = AppContextWithConfig & {
  me: UiMe | null;
  navigation: UiNavigation;
  contextError: unknown | null;
  hasSession: boolean;
  accessToken: string | null;
  sessionUserId: string | null;
  safeBasePath: string | null;
  scopeRequestHref: string | null;
  scopeRequestId: string | null;
  signOutHref: string | null;
  signOutRequestId: string | null;
  uiDefaults: ReturnType<typeof getUiDefaults>;
};

function isThenable<T = unknown>(value: unknown): value is Promise<T> {
  if (!value) return false;
  const type = typeof value;
  if (type !== "object" && type !== "function") return false;
  return typeof (value as { then?: unknown }).then === "function";
}

async function unwrapDynamicPageProps<P>(props: DynamicPageProps<P>): Promise<P> {
  if (!props || typeof props !== "object") return props as P;
  const candidate = props as DefaultPageProps;
  const shouldUnwrapParams = isThenable(candidate.params);
  const shouldUnwrapSearchParams = isThenable(candidate.searchParams);
  if (!shouldUnwrapParams && !shouldUnwrapSearchParams) return props as P;

  const resolvedParams = shouldUnwrapParams ? await candidate.params : candidate.params;
  const resolvedSearchParams = shouldUnwrapSearchParams
    ? await candidate.searchParams
    : candidate.searchParams;

  return {
    ...(props as any),
    params: resolvedParams,
    searchParams: resolvedSearchParams,
  } as P;
}

export function createConfigGuardedPage<P = DefaultPageProps>({
  loadContext,
  render,
  authMode = "optional",
  testIdPrefix,
}: {
  loadContext: () => Promise<AppContext | AppViewContextWithConfig>;
  render: (
    context: AppContextWithConfig,
    props: P
  ) => React.ReactNode | Promise<React.ReactNode>;
  authMode?: AppAuthMode;
  testIdPrefix?: string;
}) {
  return async function ConfigGuardedPage(props: DynamicPageProps<P>) {
    const context = await loadContext();
    if (!context.config) {
      return null;
    }
    const resolvedProps = await unwrapDynamicPageProps(props);
    if (authMode === "required") {
      const viewContext = context as Partial<AppViewContextWithConfig>;
      const safeBasePath = viewContext.safeBasePath ?? null;
      const callbackPath = safeBasePath
        ? `${safeBasePath}/auth/callback`
        : "/auth/callback";
      if (!viewContext.hasSession) {
        return (
          <AuthGate
            appLabel={context.appName}
            contextError={viewContext.contextError}
            testIdPrefix={testIdPrefix ?? context.appKey}
            authMethods={context.config.authMethods}
            callbackPath={callbackPath}
            appBasePath={safeBasePath ?? undefined}
            forceAuth={!viewContext.contextError}
          >
            <></>
          </AuthGate>
        );
      }
    }
    return render(context as AppContextWithConfig, resolvedProps);
  };
}

export async function createAppContext({
  appKey,
  appBasePath,
  loadMessages,
}: {
  appKey: AppKey;
  appBasePath: string;
  loadMessages: LoadMessages;
}): Promise<AppContext> {
  let config: ReturnType<typeof getPublicConfig> | null = null;
  let configError: string | null = null;

  try {
    config = getPublicConfig();
  } catch (error) {
    configError = error instanceof Error ? error.message : null;
  }

  const locale = config?.locale ?? "en";
  const isRtl = resolveLocaleDir(locale, getUiDefaults().rtlLocales) === "rtl";
  const messages = await loadMessages(locale);
  const t = createTranslator<any>({ locale, messages: messages as any });
  const appName = config?.appName ?? t("app.title");

  return {
    appKey,
    appBasePath,
    appName,
    config,
    configError,
    locale,
    isRtl,
    messages,
    t,
  };
}

export async function createAppMetadata({
  appKey,
  appBasePath,
  loadMessages,
}: {
  appKey: AppKey;
  appBasePath: string;
  loadMessages: LoadMessages;
}): Promise<Metadata> {
  const { appName, t } = await createAppContext({
    appKey,
    appBasePath,
    loadMessages,
  });
  const safeBasePath = resolveSafeAppBasePath(appBasePath);
  const iconHref = safeBasePath ? `${safeBasePath}/icon.svg` : "/icon.svg";
  return {
    title: appName,
    description: t("app.subtitle"),
    icons: {
      icon: [{ url: iconHref, type: "image/svg+xml" }],
      shortcut: [{ url: iconHref, type: "image/svg+xml" }],
      apple: [{ url: iconHref, type: "image/svg+xml" }],
    },
  };
}

function createServerRequestId() {
  return randomUUID();
}

export async function createAppViewContext({
  appKey,
  appBasePath,
  loadMessages,
}: {
  appKey: AppKey;
  appBasePath: string;
  loadMessages: LoadMessages;
}): Promise<AppContext | AppViewContextWithConfig> {
  const baseContext = await createAppContext({
    appKey,
    appBasePath,
    loadMessages,
  });
  if (!baseContext.config) {
    return baseContext;
  }

  const uiDefaults = getUiDefaults();
  const ui = createUiServerClient();
  let me: UiMe | null = null;
  let navigation: UiNavigation = { app: null, sections: [] };
  let contextError: unknown = null;
  let hasSession = false;
  let accessToken: string | null = null;
  let sessionUserId: string | null = null;

  try {
    const { user, accessToken: verifiedAccessToken, error } =
      await getVerifiedAccessToken({ allowCookieSet: false });
    hasSession = Boolean(user && verifiedAccessToken);
    accessToken = verifiedAccessToken ?? null;
    sessionUserId = decodeJwtSubject(accessToken);
    contextError =
      !user &&
      !verifiedAccessToken &&
      error instanceof Error &&
      error.message === "verified_access_token_required"
        ? null
        : error;
  } catch (error) {
    hasSession = false;
    accessToken = null;
    sessionUserId = null;
    contextError = error;
  }

  if (hasSession) {
    try {
      const context = accessToken
        ? await loadUiContextCached({
            appKey,
            accessToken,
            load: () => ui.context(appKey),
          })
        : await ui.context(appKey);
      me = context.me;
      navigation = localizeNavigation(normalizeNavigation(context.navigation), baseContext.locale);
    } catch (error) {
      contextError = error;
    }
  }

  const capabilities = Array.isArray(me?.capabilities) ? me.capabilities : [];
  const capabilitySet = resolveCapabilitySet(capabilities);
  const canRequestScope = hasCapability(capabilitySet, "access_policy.request");
  const isSuperAdmin = me?.user?.user_type === "super_admin";
  const safeBasePath = resolveSafeAppBasePath(appBasePath);
  const resolveWithBasePath = (path: string) =>
    safeBasePath ? `${safeBasePath}${path}` : path;
  const scopeRequestHref =
    hasSession && canRequestScope && !isSuperAdmin
      ? resolveWithBasePath("/access-policy/request")
      : null;
  const signOutHref = hasSession ? resolveWithBasePath("/auth/sign-out") : null;

  return {
    ...baseContext,
    config: baseContext.config,
    me,
    navigation,
    contextError,
    hasSession,
    accessToken,
    sessionUserId,
    safeBasePath,
    scopeRequestHref,
    scopeRequestId: scopeRequestHref ? createServerRequestId() : null,
    signOutHref,
    signOutRequestId: signOutHref ? createServerRequestId() : null,
    uiDefaults,
  };
}

type RootLayoutParams = {
  appKey: AppKey;
  appBasePath: string;
  loadMessages: LoadMessages;
  testIdPrefix?: string;
  authMode?: AppAuthMode;
};

export function createRootLayout({
  appKey,
  appBasePath,
  loadMessages,
  testIdPrefix = appKey,
  authMode = "required",
}: RootLayoutParams) {
  return async function RootLayout({
    children,
  }: {
    children: React.ReactNode;
  }) {
    const context = await createAppViewContext({
      appKey,
      appBasePath,
      loadMessages,
    });

    if (!context.config) {
      const errorMessage =
        context.configError ?? context.t("app.configMissing.errorFallback");
      return (
        <MissingEnvNotice
          locale={context.locale}
          appName={context.t("app.title")}
          title={context.t("app.configMissing.title")}
          description={context.t("app.configMissing.description")}
          required={context.t("app.configMissing.required")}
          optional={context.t("app.configMissing.optional")}
          errorLabel={context.t("app.configMissing.errorLabel", { error: errorMessage })}
          testIdPrefix={testIdPrefix}
        />
      );
    }
    const viewContext = context as AppViewContextWithConfig;
    const contextDetails = [];
    if (viewContext.me?.user?.id) {
      contextDetails.push({
        labelKey: "details.userId",
        value: viewContext.me.user.id,
        copyValue: viewContext.me.user.id,
        monospace: true,
      });
    }
    if (viewContext.me?.org?.id) {
      contextDetails.push({
        labelKey: "details.orgId",
        value: viewContext.me.org.id,
        copyValue: viewContext.me.org.id,
        monospace: true,
      });
    }
    if (viewContext.me?.access_scope?.scope_type) {
      const rawScopeType = viewContext.me.access_scope.scope_type;
      const normalizedScopeType =
        normalizeUiScope({
          scopeType: rawScopeType,
          scopeId: viewContext.me.access_scope?.scope_id ?? null,
        }).scopeType ?? rawScopeType;
      const scopeTypeDetailValue =
        rawScopeType && normalizedScopeType && rawScopeType !== normalizedScopeType
          ? `${normalizedScopeType} (raw: ${rawScopeType})`
          : normalizedScopeType;
      contextDetails.push({
        labelKey: "details.scopeType",
        value: scopeTypeDetailValue,
      });
    }
    if (viewContext.me?.access_scope?.scope_id) {
      contextDetails.push({
        labelKey: "details.scopeId",
        value: viewContext.me.access_scope.scope_id,
        copyValue: viewContext.me.access_scope.scope_id,
        monospace: true,
      });
    }
    if (viewContext.me?.settings_resolution_id) {
      contextDetails.push({
        labelKey: "details.settingsResolutionId",
        value: viewContext.me.settings_resolution_id,
        copyValue: viewContext.me.settings_resolution_id,
        monospace: true,
      });
    }

    const capabilities = Array.isArray(viewContext.me?.capabilities)
      ? viewContext.me.capabilities
      : [];
    const capabilitySet = resolveCapabilitySet(capabilities);
    const isSuperAdmin = viewContext.me?.user?.user_type === "super_admin";
    const navBasePath = viewContext.safeBasePath ?? undefined;

    const accessScope = viewContext.me?.access_scope ?? null;
    const normalizedScope = normalizeUiScope({
      scopeType: accessScope?.scope_type ?? null,
      scopeId: accessScope?.scope_id ?? null,
    });
    const normalizedScopeLabel =
      accessScope?.scope_label ?? normalizedScope.scopeId ?? null;
    const normalizedScopeDisplay = normalizedScope.scopeType
      ? normalizedScope.scopeType === "global" && !normalizedScopeLabel
        ? normalizedScope.scopeType
        : [normalizedScope.scopeType, normalizedScopeLabel]
            .filter(Boolean)
            .join(" ")
      : null;
    const scopeSwitcherMode = isSuperAdmin ? "details" : "inline";

    return (
      <html
        lang={context.locale}
        dir={context.isRtl ? "rtl" : "ltr"}
        className={appFontClassName}
      >
        <body>
          <NextIntlClientProvider
            locale={context.locale}
            messages={context.messages}
          >
            <ThemeProvider>
              <QueryProvider>
                <ToastHost>
                  <UiTelemetryReporter appBasePath={viewContext.safeBasePath ?? ""} />
                  <UiNavigationProvider
                    sections={viewContext.navigation.sections}
                    basePath={navBasePath}
                  >
                    <AppShell
                      appName={viewContext.config.appName}
                      appKey={appKey}
                      userId={viewContext.me?.user?.id ?? viewContext.sessionUserId ?? null}
                      layout={viewContext.uiDefaults.layout.mode}
                      layoutMaxWidth={viewContext.uiDefaults.layout.maxWidth}
                      sidebar={
                        <ErrorBoundary
                          fallback={
                            <div className="rounded-xl border border-ui-border bg-ui-surface/70 p-4">
                              <ErrorReload />
                            </div>
                          }
                        >
                          <div className="space-y-4">
                            <NavigationNext
                              organizationId={viewContext.me?.org?.id ?? null}
                              appKey={appKey}
                              basePath={navBasePath}
                              userId={viewContext.me?.user?.id ?? viewContext.sessionUserId ?? null}
                              sections={viewContext.navigation.sections}
                              capabilities={viewContext.me?.capabilities ?? null}
                              scopeType={viewContext.me?.access_scope?.scope_type ?? null}
                              scopeId={viewContext.me?.access_scope?.scope_id ?? null}
                            />
                            <ThemeToggle />
                          </div>
                        </ErrorBoundary>
                      }
                    >
                      <PageContainer>
                        <ContextStrip
                          organizationId={viewContext.me?.org?.id ?? null}
                          userId={viewContext.me?.user?.id ?? viewContext.sessionUserId ?? null}
                          userLabel={viewContext.me?.user?.email ?? viewContext.me?.user?.id ?? null}
                          orgLabel={viewContext.me?.org?.name ?? viewContext.me?.org?.id ?? null}
                          scopeLabel={normalizedScopeDisplay}
                          scopeType={normalizedScope.scopeType ?? null}
                          scopeId={normalizedScope.scopeId ?? null}
                          scopeSwitcherMode={scopeSwitcherMode}
                          scopeRequestHref={viewContext.scopeRequestHref}
                          scopeRequestId={viewContext.scopeRequestId}
                          capabilityCount={
                            viewContext.hasSession
                              ? capabilitySet.has("*")
                                ? "*"
                                : capabilitySet.size
                              : null
                          }
                          settingsResolutionId={viewContext.me?.settings_resolution_id ?? null}
                          details={contextDetails.length > 0 ? contextDetails : []}
                          signOutHref={viewContext.signOutHref}
                          signOutRequestId={viewContext.signOutRequestId}
                        />
                      </PageContainer>
                      <AuthGate
                        appLabel={viewContext.config.appName}
                        contextError={viewContext.contextError}
                        testIdPrefix={testIdPrefix}
                        authMethods={viewContext.config.authMethods}
                        callbackPath={
                          viewContext.safeBasePath
                            ? `${viewContext.safeBasePath}/auth/callback`
                            : "/auth/callback"
                        }
                        appBasePath={viewContext.safeBasePath ?? undefined}
                        forceAuth={
                          authMode === "required" &&
                          !viewContext.hasSession &&
                          !viewContext.contextError
                        }
                      >
                        <ErrorBoundary
                          fallback={
                            <PageContainer className="space-y-6">
                              <ErrorReload />
                            </PageContainer>
                          }
                        >
                          {children}
                        </ErrorBoundary>
                      </AuthGate>
                    </AppShell>
                  </UiNavigationProvider>
                </ToastHost>
              </QueryProvider>
            </ThemeProvider>
          </NextIntlClientProvider>
        </body>
      </html>
    );
  };
}
