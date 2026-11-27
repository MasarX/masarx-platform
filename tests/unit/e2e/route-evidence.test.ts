import { test as browserTest, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  buildRouteEvidenceEntry,
  captureRouteEvidence,
  isFullyInView,
  validateRouteEvidenceOptions,
} from "../../e2e/utils/evidence";

jest.mock("@playwright/test", () => ({ test: { info: jest.fn() } }));

const dashboard = { role: "finance_viewer", route: "/" };
const viewport = { viewportWidth: 390, viewportHeight: 844, x: 8, y: 16, width: 374, height: 192, ratio: 1 };
const badArgument = /^EVIDENCE_FAILED\/BAD_ARGUMENT$/;

test.each([
  ["/operations/pickups/waves", "pickup-waves"],
  ["/operations/pickups/requests", "pickup-requests"],
])("requires a ledger state for %s", (route, key) => {
  const pickup = { role: "dispatcher", route };
  for (const ledgerState of ["rows", "empty"]) {
    expect(validateRouteEvidenceOptions({ ...pickup, ledgerState }))
      .toStrictEqual({ role: "dispatcher", route: key, ledgerState });
  }
  expect(() => validateRouteEvidenceOptions(pickup)).toThrow(badArgument);
  expect(() => validateRouteEvidenceOptions({ ...pickup, ledgerState: "loading" })).toThrow(badArgument);
});

test.each([
  ["/", "dashboard"],
  ["/operations/routes", "dispatch"],
])("forbids a ledger state for %s", (route, key) => {
  const options = { role: "dispatcher", route };
  expect(validateRouteEvidenceOptions(options)).toStrictEqual({ role: "dispatcher", route: key });
  for (const ledgerState of ["rows", "empty", undefined]) {
    expect(() => validateRouteEvidenceOptions({ ...options, ledgerState })).toThrow(badArgument);
  }
});

test("rejects unknown roles and routes", () => {
  expect(() => validateRouteEvidenceOptions({ ...dashboard, role: "unknown" })).toThrow(badArgument);
  expect(() => validateRouteEvidenceOptions({ ...dashboard, route: "/unknown" })).toThrow(badArgument);
});

test("builds an entry with exactly the fields for its route", () => {
  expect(buildRouteEvidenceEntry(validateRouteEvidenceOptions(dashboard), "phone-dark"))
    .toStrictEqual({
      role: "finance_viewer",
      route: "dashboard",
      variant: "phone-dark",
      outcome: "CAPTURED",
      image: "finance_viewer-dashboard-phone-dark.png",
    });
  const pickup = { role: "dispatcher", route: "/operations/pickups/requests", ledgerState: "empty" };
  expect(buildRouteEvidenceEntry(validateRouteEvidenceOptions(pickup), "desktop-light"))
    .toStrictEqual({
      role: "dispatcher",
      route: "pickup-requests",
      variant: "desktop-light",
      ledgerState: "empty",
      outcome: "CAPTURED",
      image: "dispatcher-pickup-requests-desktop-light.png",
    });
});

test("requires a nonempty box fully inside the viewport and free of ancestor clipping", () => {
  expect(isFullyInView(viewport)).toBe(true);
  expect(isFullyInView({ ...viewport, ratio: 0.9 })).toBe(false);
  expect(isFullyInView({ ...viewport, y: -1 })).toBe(false);
  expect(isFullyInView({ ...viewport, width: viewport.viewportWidth })).toBe(false);
  expect(isFullyInView({ ...viewport, height: 0 })).toBe(false);
});

test("fails before taking an image if a required mask is missing", async () => {
  jest.mocked(browserTest.info).mockReturnValue({ project: { name: "phone-dark" } } as TestInfo);
  const evaluateAll = jest.fn().mockResolvedValue(viewport);
  const screenshot = jest.fn();
  const page = {
    screenshot,
    locator: (selector: string) => ({
      count: async () => Number(selector.includes("context-identity")),
    }),
  };
  await expect(captureRouteEvidence(page as unknown as Page, { evaluateAll } as unknown as Locator, dashboard))
    .rejects.toHaveProperty("message", "EVIDENCE_FAILED/MASK_MISSING");
  expect(evaluateAll).toHaveBeenCalledTimes(1);
  expect(screenshot).not.toHaveBeenCalled();
});

test("drops the runner error and exposes only the fixed failure code", async () => {
  jest.mocked(browserTest.info).mockReturnValue({ project: { name: "phone-dark" } } as TestInfo);
  const syntheticAddress = ["fixture-user", "example.test"].join("@");
  const locator = {
    evaluateAll: jest.fn().mockRejectedValue(new Error("Unexpected value " + syntheticAddress)),
  };
  await expect(captureRouteEvidence({} as Page, locator as unknown as Locator, dashboard))
    .rejects.toHaveProperty("message", "EVIDENCE_FAILED/CAPTURE_FAILED");
});
