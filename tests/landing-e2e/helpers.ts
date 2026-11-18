import type { Page, Route } from "@playwright/test";

export const LANDING_CONTACT_ENDPOINT_MOCK = "/__landing-contact";
export const LANDING_CONTACT_ROUTE = `**${LANDING_CONTACT_ENDPOINT_MOCK}`;
export const LANDING_TENANT_SIGNUP_ENDPOINT_MOCK = "/__tenant-signup";
export const LANDING_TENANT_SIGNUP_ROUTE = `**${LANDING_TENANT_SIGNUP_ENDPOINT_MOCK}`;
export const LANDING_DRIVER_SIGNUP_ENDPOINT_MOCK = "/__driver-signup";
export const LANDING_DRIVER_SIGNUP_ROUTE = `**${LANDING_DRIVER_SIGNUP_ENDPOINT_MOCK}`;
export const LANDING_DRIVER_STATUS_ENDPOINT_MOCK = "/__driver-status";
export const LANDING_DRIVER_STATUS_ROUTE = `**${LANDING_DRIVER_STATUS_ENDPOINT_MOCK}`;
export const LANDING_TRACKING_ENDPOINT_MOCK = "/__landing-tracking";
export const LANDING_TRACKING_ROUTE = `**${LANDING_TRACKING_ENDPOINT_MOCK}/**`;

type RuntimePatchOptions = {
  appUrl?: string;
  clientsEndpoint?: string;
  contactEndpoint?: string;
  tenantSignupEndpoint?: string;
  driverSignupEndpoint?: string;
  driverApplicationStatusEndpoint?: string;
  trackingEndpoint?: string;
  turnstileSiteKey?: string;
};

type RuntimePatchMap = Record<string, string>;

function buildRuntimePatch({
  appUrl,
  clientsEndpoint,
  contactEndpoint,
  tenantSignupEndpoint,
  driverSignupEndpoint,
  driverApplicationStatusEndpoint,
  trackingEndpoint,
  turnstileSiteKey,
}: RuntimePatchOptions): RuntimePatchMap {
  const runtimePatch: RuntimePatchMap = {};

  if (typeof appUrl === "string") runtimePatch.appUrl = appUrl;
  if (typeof clientsEndpoint === "string") runtimePatch.clientsEndpoint = clientsEndpoint;
  if (typeof contactEndpoint === "string") runtimePatch.contactEndpoint = contactEndpoint;

  if (typeof tenantSignupEndpoint === "string") {
    runtimePatch.tenantSignupEndpoint = tenantSignupEndpoint;
  }

  const resolvedDriverSignupEndpoint =
    typeof driverSignupEndpoint === "string"
      ? driverSignupEndpoint
      : typeof contactEndpoint === "string"
        ? contactEndpoint
        : null;
  if (typeof resolvedDriverSignupEndpoint === "string") {
    runtimePatch.driverSignupEndpoint = resolvedDriverSignupEndpoint;
  }

  if (typeof driverApplicationStatusEndpoint === "string") {
    runtimePatch.driverApplicationStatusEndpoint = driverApplicationStatusEndpoint;
  }

  if (typeof trackingEndpoint === "string") runtimePatch.trackingEndpoint = trackingEndpoint;
  if (typeof turnstileSiteKey === "string") runtimePatch.turnstileSiteKey = turnstileSiteKey;

  return runtimePatch;
}

export function mergeRuntimeConfig(
  runtimePatch: RuntimePatchMap,
  runtimeValue: unknown,
): Record<string, unknown> {
  const current =
    runtimeValue != null && typeof runtimeValue === "object" && !Array.isArray(runtimeValue)
      ? { ...(runtimeValue as Record<string, unknown>) }
      : {};

  for (const [key, value] of Object.entries(runtimePatch)) {
    current[key] = value;
  }

  return current;
}

export async function patchRuntimeConfig(page: Page, {
  appUrl,
  clientsEndpoint,
  contactEndpoint,
  tenantSignupEndpoint,
  driverSignupEndpoint,
  driverApplicationStatusEndpoint,
  trackingEndpoint,
  turnstileSiteKey,
}: RuntimePatchOptions = {}): Promise<void> {
  const runtimePatch = buildRuntimePatch({
    appUrl,
    clientsEndpoint,
    contactEndpoint,
    tenantSignupEndpoint,
    driverSignupEndpoint,
    driverApplicationStatusEndpoint,
    trackingEndpoint,
    turnstileSiteKey,
  });

  if (Object.keys(runtimePatch).length === 0) {
    return;
  }

  await page.addInitScript((patch: RuntimePatchMap) => {
    const runtimePatchEntries = Object.entries(patch);
    const mergeRuntimeConfigInPage = (runtimeValue: unknown) => {
      const current =
        runtimeValue != null && typeof runtimeValue === "object" && !Array.isArray(runtimeValue)
          ? { ...(runtimeValue as Record<string, unknown>) }
          : {};

      for (const [key, value] of runtimePatchEntries) {
        current[key] = value;
      }

      return current;
    };

    let runtimeValue = mergeRuntimeConfigInPage((window as { MASARX_RUNTIME?: unknown }).MASARX_RUNTIME);

    Object.defineProperty(window, "MASARX_RUNTIME", {
      configurable: true,
      enumerable: true,
      get() {
        return runtimeValue;
      },
      set(value) {
        runtimeValue = mergeRuntimeConfigInPage(value);
      },
    });
  }, runtimePatch);
}

export function routePayload(data: Record<string, unknown> = {}, status = 200) {
  return async (route: Route): Promise<void> => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  };
}

export function routePayloadWithDelay(
  data: Record<string, unknown> = {},
  status = 200,
  delayMs = 250,
) {
  return async (route: Route): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await routePayload(data, status)(route);
  };
}

export async function mockContactEndpoint(
  page: Page,
  responseFn: (route: Route) => Promise<void>,
): Promise<void> {
  await page.route(LANDING_CONTACT_ROUTE, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    await responseFn(route);
  });
}

export async function mockTenantSignupEndpoint(
  page: Page,
  responseFn: (route: Route) => Promise<void>,
): Promise<void> {
  await page.route(LANDING_TENANT_SIGNUP_ROUTE, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    await responseFn(route);
  });
}

export async function mockDriverSignupEndpoint(
  page: Page,
  responseFn: (route: Route) => Promise<void>,
): Promise<void> {
  await page.route(LANDING_DRIVER_SIGNUP_ROUTE, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    await responseFn(route);
  });
}

export async function mockDriverStatusEndpoint(
  page: Page,
  responseFn: (route: Route) => Promise<void>,
): Promise<void> {
  await page.route(LANDING_DRIVER_STATUS_ROUTE, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    await responseFn(route);
  });
}

export async function mockTrackingEndpoint(
  page: Page,
  responseFn: (route: Route) => Promise<void>,
): Promise<void> {
  await page.route(LANDING_TRACKING_ROUTE, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    await responseFn(route);
  });
}

export function getContactSubmitStateLocator(page: Page) {
  return page.locator("[data-contact-form]");
}
