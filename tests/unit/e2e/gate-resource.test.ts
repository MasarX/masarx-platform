import { buildGateResourceCandidates } from "../../e2e/utils/gate-resource";

describe("gate resource candidate builder", () => {
  test("deduplicates navigation and registry resource routes", () => {
    expect(
      buildGateResourceCandidates({
        basePath: "",
        sections: [
          {
            id: "operations",
            items: [
              {
                id: "shipments-nav",
                href: "/resources/shipments",
              },
              {
                id: "shipments-nav-dup",
                href: "/resources/shipments",
              },
              {
                id: "blocked-nav",
                href: "/resources/organizations",
                disabled_reason: "capability missing",
              },
            ],
          },
        ],
        readRegistry: {
          resources: [
            { key: "shipments" },
            { key: "organizations" },
            { key: "workflow_runs" },
          ],
        },
      })
    ).toEqual([
      "/resources/shipments",
      "/resources/organizations",
      "/resources/workflow_runs",
    ]);
  });

  test("normalizes routes against the app base path", () => {
    expect(
      buildGateResourceCandidates({
        basePath: "/console",
        sections: [
          {
            id: "resources",
            items: [
              {
                id: "shipments-nav",
                href: "/console/resources/shipments",
              },
            ],
          },
        ],
        readRegistry: {
          resources: [{ key: "workflow_templates" }],
        },
      })
    ).toEqual([
      "/console/resources/shipments",
      "/console/resources/workflow_templates",
    ]);
  });
});
