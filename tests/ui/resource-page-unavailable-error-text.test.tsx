jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
  useParams: () => ({}),
}));

import enUiMessages from "../../packages/config/messages/en.json";
import arUiMessages from "../../packages/config/messages/ar.json";
import enPortalMessages from "../../apps/portal/messages/en.json";
import arPortalMessages from "../../apps/portal/messages/ar.json";

// Synthetic backend wording that matches none of the formatter's recognised classes (#723).
const BACKEND_TEXT = "Synthetic registry row zz_synthetic_rows could not be read";

const cases = [
  ["en", { ...enUiMessages, ...enPortalMessages }, "Refresh the page or try again later."],
  ["ar", { ...arUiMessages, ...arPortalMessages }, "حدّث الصفحة أو حاول مرة أخرى لاحقًا."],
] as const;

describe("ResourcePage unavailable state", () => {
  const previousLocale = process.env.NEXT_PUBLIC_LOCALE;

  afterEach(() => {
    if (previousLocale === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
    else process.env.NEXT_PUBLIC_LOCALE = previousLocale;
  });

  it.each(cases)(
    "shows translated text and a retry control without backend wording in %s",
    async (locale, messages, nextStep) => {
      process.env.NEXT_PUBLIC_LOCALE = locale;
      // The page's translators resolve the locale at import, so each locale loads a fresh module graph.
      const modules = {} as {
        React: typeof import("react");
        server: typeof import("react-dom/server");
        intl: typeof import("next-intl");
        api: typeof import("@masarx/api/server");
        page: typeof import("../../packages/ui/src/resource-page");
        query: typeof import("../../packages/ui/src/query-provider");
        toast: typeof import("../../packages/ui/src/use-toast");
      };
      jest.isolateModules(() => {
        Object.assign(modules, {
          React: require("react"),
          server: require("react-dom/server"),
          intl: require("next-intl"),
          api: require("@masarx/api/server"),
          page: require("../../packages/ui/src/resource-page"),
          query: require("../../packages/ui/src/query-provider"),
          toast: require("../../packages/ui/src/use-toast"),
        });
      });
      const { React, server, intl, api, page, query, toast } = modules;
      (api.createUiServerClient as unknown as jest.Mock).mockReturnValue({
        readRegistry: jest.fn().mockRejectedValue({ message: BACKEND_TEXT }),
        me: jest.fn().mockResolvedValue({ capabilities: ["shipments.read"] }),
        listResource: jest.fn().mockRejectedValue(new Error(BACKEND_TEXT)),
      });

      const element = await page.ResourcePage({
        appKey: "portal",
        appBasePath: "/portal",
        resourceKey: "shipments",
        searchParams: { status: "open" },
        testIdPrefix: "portal-shipments",
      });
      const markup = server.renderToStaticMarkup(
        React.createElement(
          intl.NextIntlClientProvider,
          { locale, messages: messages as Record<string, unknown> },
          React.createElement(
            query.QueryProvider,
            null,
            React.createElement(toast.ToastHost, null, element)
          )
        )
      );

      expect(markup).toContain('data-testid="portal-shipments-error"');
      expect(markup).toContain(nextStep);
      expect(markup).toMatch(
        /<a href="\/portal\/resources\/shipments\?status=open"[^>]*data-testid="portal-shipments-error-retry"/
      );
      expect(markup).not.toContain(BACKEND_TEXT);
      expect(markup).not.toMatch(/zz_synthetic_rows|registry row/i);
    }
  );
});
