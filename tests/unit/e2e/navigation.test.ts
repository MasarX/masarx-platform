import {
  extractResourceRoutes,
  normalizeResourceHref,
} from "../../e2e/utils/navigation";

describe("e2e navigation resource discovery helpers", () => {
  test("normalizes app-prefixed resource hrefs without changing canonical paths", () => {
    expect(normalizeResourceHref("console", "/console/resources/shipments")).toBe(
      "/resources/shipments"
    );
    expect(normalizeResourceHref("portal", "/portal/resources/pickups")).toBe(
      "/resources/pickups"
    );
    expect(normalizeResourceHref("console", "/resources/workflow_runs")).toBe(
      "/resources/workflow_runs"
    );
  });

  test("keeps null resource hrefs null", () => {
    expect(normalizeResourceHref("console", null)).toBeNull();
    expect(normalizeResourceHref("portal", undefined)).toBeNull();
  });

  test("extracts nested resource routes and skips non-resource links", () => {
    expect(
      extractResourceRoutes([
        {
          id: "ops",
          items: [
            {
              id: "dashboard",
              href: "/dashboard",
              resource: "dashboard",
            },
            {
              id: "nested",
              items: [
                {
                  id: "shipments",
                  href: "/console/resources/shipments",
                  resource: "shipments",
                },
                {
                  id: "shipments-duplicate",
                  href: "/console/resources/shipments",
                  resource: "shipments",
                },
                {
                  id: "workflow-runs",
                  href: "/resources/workflow_runs",
                  resource: "workflow_runs",
                },
              ],
            },
          ],
        },
      ])
    ).toEqual([
      expect.objectContaining({
        href: "/console/resources/shipments",
        resource: "shipments",
      }),
      expect.objectContaining({
        href: "/resources/workflow_runs",
        resource: "workflow_runs",
      }),
    ]);
  });
});
