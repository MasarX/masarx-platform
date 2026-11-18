import { resolveAppBasePath } from "../../apps/shared/app-base-path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server.node";
import { within } from "@testing-library/react";
import { createAppContext, createConfigGuardedPage, createRootLayout } from "../../apps/shared/app-layout";
import { createUiServerClient } from "@masarx/api/server";

// Preserve real RootLayout, scope normalization and ContextStrip rendering.
// Only unrelated shells and server/network boundaries are replaced.
jest.mock("@masarx/ui", () => {
  const React = require("react");
  const wrap = ({ children }: { children?: import("react").ReactNode }) => React.createElement(React.Fragment, null, children);
  return {
    ...jest.requireActual("../../packages/ui/src/capabilities"),
    ContextStrip: jest.requireActual("../../packages/ui/src/context-strip").ContextStrip,
    AppShell: wrap, PageContainer: wrap, AuthGate: wrap, NavigationNext: () => null,
  };
});
jest.mock("@masarx/ui/client", () => {
  const React = require("react");
  const wrap = ({ children }: { children?: import("react").ReactNode }) => React.createElement(React.Fragment, null, children);
  return { ErrorBoundary: wrap, QueryProvider: wrap, ThemeProvider: wrap, ToastHost: wrap,
    UiNavigationProvider: wrap, ErrorReload: () => null, ThemeToggle: () => null };
});
jest.mock("@masarx/api/server", () => ({ createUiServerClient: jest.fn() }));
jest.mock("@masarx/auth", () => ({ getVerifiedAccessToken: async () => ({
  user: { id: "different-user" }, accessToken: "verified-test-token", error: null,
}) }));
jest.mock("@masarx/config", () => ({
  getPublicConfig: () => ({ appName: "Scope test", locale: "en", authMethods: [] }),
  getUiDefaults: jest.requireActual("@masarx/config").getUiDefaults,
}));
jest.mock("../../apps/shared/ui-context-cache", () => ({
  loadUiContextCached: ({ load }: { load: () => unknown }) => load(),
}));
jest.mock("../../apps/shared/ui-telemetry", () => ({ UiTelemetryReporter: () => null }));
jest.mock("../../packages/ui/src/use-toast", () => ({ useToast: () => ({ toast: jest.fn() }) }));
jest.mock("../../packages/ui/src/read-registry-client", () => ({ useReadRegistry: () => ({ data: {
  scopes: ["tenant", "client", "sender"].map(scope_type => ({
    scope_type, scope_id: `scope-${scope_type}`, scope_label: `Option ${scope_type}`,
    href: `/scope/${scope_type}`,
  })),
} }) }));
jest.mock("../../packages/ui/src/i18n", () => ({
  createUiTranslator: () => (key: string) => key === "scopeSwitcher.aria" ? "Change scope" : key,
}));

describe("actual shared layout UiMe scope rendering", () => {
  const context = jest.fn();
  const containers: HTMLElement[] = [];
  afterEach(() => {
    for (const container of containers.splice(0)) container.remove();
  });
  beforeEach(() => {
    context.mockReset();
    jest.mocked(createUiServerClient).mockReturnValue({ context } as any);
  });
  async function renderScope(scopeType: string, scopeId: string | null) {
    context.mockResolvedValue({ me: {
      user: { id: "different-user", email: "user@example.test", user_type: "ops_admin" },
      org: { id: "different-org", name: "Different organization" },
      access_scope: { scope_type: scopeType, scope_id: scopeId, scope_label: null },
      capabilities: [], settings_resolution_id: null,
    }, navigation: { app: null, sections: [] } });
    const Layout = createRootLayout({ appKey: "console", appBasePath: "", loadMessages: async () => ({}) });
    const markup = renderToStaticMarkup(await Layout({ children: <main>Page content</main> }));
    // Parse the real rendered document; no JSX/source-string inspection or synthetic scope component.
    const parsed = new DOMParser().parseFromString(markup, "text/html");
    const container = document.createElement("div");
    container.append(...Array.from(parsed.body.childNodes, node => document.importNode(node, true)));
    document.body.append(container);
    containers.push(container);
    return within(container);
  }
  test.each(["tenant", "client", "sender"])("renders and selects the authoritative %s scope, not user/org identity", async type => {
    const dom = await renderScope(type, `scope-${type}`);
    expect(dom.getByText(`${type} scope-${type}`, { exact: true })).toBeTruthy();
    expect((dom.getByRole("combobox", { name: "Change scope" }) as HTMLSelectElement).value)
      .toBe(`${type}::scope-${type}`);
    expect(dom.queryByText(`${type} different-user`, { exact: true })).toBeNull();
    expect(dom.queryByText(`${type} different-org`, { exact: true })).toBeNull();
    expect(context).toHaveBeenCalledWith("console");
  });
  test.each(["tenant", "client", "sender"])("does not synthesize a missing %s scope ID from user/org", async type => {
    const dom = await renderScope(type, null);
    expect(dom.getByText(type, { exact: true })).toBeTruthy();
    expect((dom.getByRole("combobox", { name: "Change scope" }) as HTMLSelectElement).value).toBe("");
    expect(dom.queryByText(`${type} different-user`, { exact: true })).toBeNull();
    expect(dom.queryByText(`${type} different-org`, { exact: true })).toBeNull();
  });
  test("platform remains globally rendered without preserving its supplied scope ID", async () => {
    const dom = await renderScope("platform", "discard-platform-id");
    expect(dom.getByText("global", { exact: true })).toBeTruthy();
    expect((dom.getByRole("combobox", { name: "Change scope" }) as HTMLSelectElement).value).toBe("");
    expect(dom.queryByText("global discard-platform-id", { exact: true })).toBeNull();
  });
});

describe("shared Next page props boundary", () => {
  const loadContext = () => createAppContext({
    appKey: "portal", appBasePath: "/portal", loadMessages: async () => ({}),
  });

  test("awaits dynamic route and repeated query values before rendering", async () => {
    const render = jest.fn(() => null);
    const Page = createConfigGuardedPage<{
      params: { resource: string };
      searchParams: Record<string, string | string[] | undefined>;
    }>({ loadContext, render });
    const params = { resource: "shipments" };
    const searchParams = { status: ["pending", "active"], omitted: undefined };
    await Page({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) });
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ appKey: "portal" }), {
      params, searchParams,
    });
  });

  test("preserves absent optional props and legacy resolved runtime input", async () => {
    const render = jest.fn(() => null);
    const Page = createConfigGuardedPage({ loadContext, render });
    await Page({});
    expect(render).toHaveBeenLastCalledWith(expect.anything(), {});
    const props = { params: { resource: "shipments" }, searchParams: { id: "one" } };
    await Page(props as any);
    expect(render).toHaveBeenLastCalledWith(expect.anything(), props);
  });

  test("never renders a protected page without a session", async () => {
    const render = jest.fn(() => null);
    const Page = createConfigGuardedPage({
      loadContext: async () => ({ ...await loadContext(), hasSession: false }),
      render, authMode: "required",
    });
    const node = await Page({ searchParams: Promise.resolve({ id: "private" }) });
    expect(node).not.toBeNull();
    expect(render).not.toHaveBeenCalled();
  });

  test("keeps missing configuration and rejected route values fail-closed", async () => {
    const render = jest.fn(() => null);
    const Missing = createConfigGuardedPage({
      loadContext: async () => ({ ...await loadContext(), config: null }), render,
    });
    expect(await Missing({})).toBeNull();
    const Page = createConfigGuardedPage({ loadContext, render });
    await expect(Page({ params: Promise.reject(new Error("invalid route")) }))
      .rejects.toThrow("invalid route");
    expect(render).not.toHaveBeenCalled();
  });
});

describe("resolveAppBasePath", () => {
  const originalEnv = process.env.NEXT_PUBLIC_APP_BASE_PATH;
  const appDir = "/workspace/apps/console";

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NEXT_PUBLIC_APP_BASE_PATH;
    } else {
      process.env.NEXT_PUBLIC_APP_BASE_PATH = originalEnv;
    }
  });

  test("falls back to host-root when env is unset", () => {
    delete process.env.NEXT_PUBLIC_APP_BASE_PATH;
    expect(resolveAppBasePath(appDir)).toBe("");
  });

  test("uses a trusted app base path when configured", () => {
    process.env.NEXT_PUBLIC_APP_BASE_PATH = "/portal";
    expect(resolveAppBasePath(appDir)).toBe("/portal");
  });

  test("normalizes a trailing slash on a safe configured base path", () => {
    process.env.NEXT_PUBLIC_APP_BASE_PATH = "/portal/";
    expect(resolveAppBasePath(appDir)).toBe("/portal");
  });

  test("rejects unsafe base paths and falls back to host-root", () => {
    process.env.NEXT_PUBLIC_APP_BASE_PATH = "javascript:alert(1)";
    expect(resolveAppBasePath(appDir)).toBe("");
  });

  test("rejects protocol-relative base paths and falls back to host-root", () => {
    process.env.NEXT_PUBLIC_APP_BASE_PATH = "//portal";
    expect(resolveAppBasePath(appDir)).toBe("");
  });
});
