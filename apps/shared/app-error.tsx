"use client";

import * as React from "react";
import { AppShell, ErrorState, PageContainer } from "@masarx/ui/client";
import { getPublicConfig, getUiDefaults } from "@masarx/config";
import { reportClientError } from "@masarx/ui/client";

type ErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

type AppErrorContext = {
  appName: string;
  locale: string;
  layoutMode: "full" | "contained";
  layoutMaxWidth: string;
};

function resolveAppErrorContext(): AppErrorContext {
  try {
    const config = getPublicConfig();
    const uiDefaults = getUiDefaults();
    return {
      appName: config.appName,
      locale: config.locale,
      layoutMode: uiDefaults.layout.mode,
      layoutMaxWidth: uiDefaults.layout.maxWidth,
    };
  } catch {
    const uiDefaults = getUiDefaults();
    return {
      appName: "App",
      locale: "en",
      layoutMode: uiDefaults.layout.mode,
      layoutMaxWidth: uiDefaults.layout.maxWidth,
    };
  }
}

function resolveErrorRequestId(error: Error): string | undefined {
  const digest = (error as Error & { digest?: string }).digest;
  if (!digest) return undefined;
  const normalized = String(digest).trim();
  const requestIdMatch = normalized.match(
    /\b[0-9a-fA-F-]{8,128}\b/
  );
  return requestIdMatch ? requestIdMatch[0] : undefined;
}

function AppErrorContent({ error, reset }: ErrorPageProps) {
  React.useEffect(() => {
    const requestId = resolveErrorRequestId(error);
    reportClientError(error, {
      context: "AppErrorPage",
      digest: error.digest,
      requestId,
    });
  }, [error]);

  return (
    <PageContainer className="space-y-6">
      <ErrorState error={error} onAction={reset} />
    </PageContainer>
  );
}

export function AppErrorPage(props: ErrorPageProps) {
  return <AppErrorContent {...props} />;
}

export function AppGlobalErrorPage(props: ErrorPageProps) {
  const { locale, appName, layoutMode, layoutMaxWidth } = resolveAppErrorContext();
  return (
    <html lang={locale}>
      <body>
        <AppShell
          appName={appName}
          layout={layoutMode}
          layoutMaxWidth={layoutMaxWidth}
        >
          <AppErrorContent {...props} />
        </AppShell>
      </body>
    </html>
  );
}
