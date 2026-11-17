const KNOWN_HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

type ApiMethod = (typeof KNOWN_HTTP_METHODS)[number];

type ApiContract = {
  routeLabel: string;
  modulePath: string;
  allowedMethods: ReadonlyArray<ApiMethod>;
};

const routes: ApiContract[] = [
  {
    routeLabel: "console: /api/ui-event",
    modulePath: "../../apps/console/app/api/ui-event/route",
    allowedMethods: ["POST"],
  },
  {
    routeLabel: "portal: /api/ui-event",
    modulePath: "../../apps/portal/app/api/ui-event/route",
    allowedMethods: ["POST"],
  },
  {
    routeLabel: "console: /api/resource-download",
    modulePath: "../../apps/console/app/api/resource-download/route",
    allowedMethods: ["GET"],
  },
  {
    routeLabel: "portal: /api/resource-download",
    modulePath: "../../apps/portal/app/api/resource-download/route",
    allowedMethods: ["GET"],
  },
  {
    routeLabel: "console: /auth/callback",
    modulePath: "../../apps/console/app/auth/callback/route",
    allowedMethods: ["GET"],
  },
  {
    routeLabel: "portal: /auth/callback",
    modulePath: "../../apps/portal/app/auth/callback/route",
    allowedMethods: ["GET"],
  },
  {
    routeLabel: "console: /auth/sign-out",
    modulePath: "../../apps/console/app/auth/sign-out/route",
    allowedMethods: ["GET"],
  },
  {
    routeLabel: "portal: /auth/sign-out",
    modulePath: "../../apps/portal/app/auth/sign-out/route",
    allowedMethods: ["GET"],
  },
];

const extractHttpMethods = (moduleExports: Record<string, unknown>): ApiMethod[] => {
  return KNOWN_HTTP_METHODS.filter(
    (method) => typeof moduleExports[method] === "function"
  );
};

describe("frontend API route method contracts", () => {
  test.each(routes)("exposes only allowed HTTP methods for %s", async (contract) => {
    const moduleExports = (await import(contract.modulePath)) as Record<
      string,
      unknown
    >;
    const presentMethods = extractHttpMethods(moduleExports);

    expect(presentMethods).toEqual(Array.from(contract.allowedMethods));
  });
});
