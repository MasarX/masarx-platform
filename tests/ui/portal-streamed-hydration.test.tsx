import { act } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { Suspense } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server.node";
import { AppShell } from "../../packages/ui/src/app-shell";
import { AuthGate } from "../../packages/ui/src/auth-gate";
import { ErrorBoundary } from "../../packages/ui/src/error-boundary";
import { NavigationNext } from "../../packages/ui/src/navigation-next";
import { buildNavigationStorageKey } from "../../packages/ui/src/navigation-preferences";
import { QueryProvider } from "../../packages/ui/src/query-provider";
import { Section } from "../../packages/ui/src/section";
import { ThemeProvider, THEME_STORAGE_KEY } from "../../packages/ui/src/theme";
import { ThemeToggle } from "../../packages/ui/src/theme-toggle";
import { UiNavigationProvider } from "../../packages/ui/src/ui-navigation-context";
import { ToastHost } from "../../packages/ui/src/use-toast";

jest.mock("next/navigation", () => ({
  usePathname: () => "/resources/shipments",
}));

test("shell mount keeps one Portal notice while its streamed reveal is pending", async () => {
  const marker = "[data-portal-notice]";
  const sections = [{
    id: "operations",
    label: "Operations",
    items: [{ id: "shipments", label: "Shipments", href: "/resources/shipments" }],
  }];
  const storageKey = buildNavigationStorageKey("portal");
  const app = (
    <NextIntlClientProvider locale="en" messages={{}}>
      <ThemeProvider>
        <QueryProvider>
          <ToastHost>
            <UiNavigationProvider sections={sections}>
              <AppShell appKey="portal" appName="Portal" sidebar={
                <>
                  <NavigationNext appKey="portal" sections={sections} />
                  <ThemeToggle />
                </>
              }>
                <AuthGate appLabel="Portal" testIdPrefix="portal">
                  <ErrorBoundary fallback={null}>
                    <Suspense fallback={null}>
                      <div data-portal-notice>
                        <Section title="Notice" collapsible collapseKey="notice">
                          Portal notice
                        </Section>
                      </div>
                    </Suspense>
                  </ErrorBoundary>
                </AuthGate>
              </AppShell>
            </UiNavigationProvider>
          </ToastHost>
        </QueryProvider>
      </ThemeProvider>
    </NextIntlClientProvider>
  );

  const container = document.createElement("div");
  container.innerHTML = renderToString(app);
  const serverNotice = container.querySelector<HTMLElement>(marker);
  const boundary = serverNotice?.previousSibling as (Comment & { _reactRetry?: () => void }) | null;
  if (!serverNotice || boundary?.data !== "$") {
    throw new Error("Expected the server-rendered Suspense notice");
  }

  // Recreate the DOM after React's $RC queues the reveal, but before $RV runs.
  const placeholder = document.createElement("template");
  placeholder.id = "B:0";
  serverNotice.before(placeholder);
  boundary.data = "$~";
  const segment = document.createElement("div");
  segment.hidden = true;
  segment.id = "S:0";
  segment.append(serverNotice);
  document.body.append(container, segment);
  localStorage.setItem(storageKey, JSON.stringify({ collapsedSections: ["operations", "notice"] }));
  localStorage.setItem(THEME_STORAGE_KEY, "dark");

  const rootElement = document.documentElement;
  const previousTheme = rootElement.getAttribute("data-theme");
  const previousColorScheme = rootElement.style.colorScheme;
  let root: Root | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, app);
    });

    expect(document.querySelectorAll(marker)).toHaveLength(1);
    expect(serverNotice).not.toBeVisible();

    await act(async () => {
      placeholder.replaceWith(serverNotice);
      segment.remove();
      boundary.data = "$";
      boundary._reactRetry?.();
    });

    expect(document.querySelectorAll(marker)).toHaveLength(1);
    expect(document.querySelector(marker)).toBe(serverNotice);
    expect(serverNotice).toBeVisible();
    expect(serverNotice.querySelector("details")).not.toHaveAttribute("open");
    expect(rootElement).toHaveAttribute("data-theme", "dark");
  } finally {
    await act(async () => root?.unmount());
    container.remove();
    segment.remove();
    localStorage.removeItem(storageKey);
    localStorage.removeItem(THEME_STORAGE_KEY);
    if (previousTheme === null) rootElement.removeAttribute("data-theme");
    else rootElement.setAttribute("data-theme", previousTheme);
    rootElement.style.colorScheme = previousColorScheme;
  }
});
