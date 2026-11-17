import type { NavigationSection } from "../../packages/ui/src/navigation";
import {
  buildDashboardCommandCenterLanes,
  buildDashboardCommandCenterSummary,
  buildDashboardSections,
  collectDashboardCommandAuthorityConflicts,
  collectDashboardNavigationAuthorityConflicts,
  collectDashboardResourceAuthorityConflicts,
  collectResourceKeys,
  commandResourceReadAllowed,
  extractResourceKeyFromHref,
  normalizeDashboardCommands,
  resolveDashboardResourceReadState,
  selectDashboardSections,
} from "../../packages/ui/src/dashboard-utils";

const navigationSections: NavigationSection[] = [
  {
    id: "ops",
    label: "Operations",
    items: [
      {
        id: "shipments",
        label: "Shipments",
        href: "/console/resources/shipments",
        resource: " shipments ",
      },
      {
        id: "nested",
        label: "Nested",
        items: [
          {
            id: "labels",
            label: "Labels",
            href: "/console/resources/labels?view=all",
          },
          {
            id: "no-link",
            label: "No Link",
            resource: "hidden_resource",
          },
        ],
      },
    ],
  },
  {
    id: "observability",
    label: "Observability",
    items: [
      {
        id: "events",
        label: "Events",
        href: "/console/resources/domain_events",
      },
    ],
  },
];

test("extractResourceKeyFromHref extracts registry keys from resource urls", () => {
  expect(extractResourceKeyFromHref("/console/resources/shipments")).toBe(
    "shipments",
  );
  expect(
    extractResourceKeyFromHref(" /console/console/resources/labels?view=all "),
  ).toBe("labels");
  expect(extractResourceKeyFromHref(null)).toBeNull();
});

test("buildDashboardSections flattens navigation items and respects limits", () => {
  const sections = buildDashboardSections(navigationSections, {
    maxItemsPerSection: 2,
    maxSections: 1,
  });

  expect(sections).toHaveLength(1);
  expect(sections[0].items.map((item) => item.id)).toEqual([
    "shipments",
    "labels",
  ]);
});

test("buildDashboardSections can retain resource-only items for registry-backed lanes", () => {
  const sections = buildDashboardSections(navigationSections, {
    includeResourceOnly: true,
    maxItemsPerSection: 5,
    maxSections: 1,
  });

  expect(sections).toHaveLength(1);
  expect(sections[0].items.map((item) => item.id)).toEqual([
    "shipments",
    "labels",
    "no-link",
  ]);
  expect(sections[0].items[2]).toMatchObject({
    resourceKey: "hidden_resource",
    href: null,
  });
});

test("collectResourceKeys de-duplicates resource keys", () => {
  const sections = buildDashboardSections(navigationSections, {
    maxItemsPerSection: 5,
    maxSections: 2,
  });
  const keys = collectResourceKeys(sections);

  expect(keys).toEqual(["shipments", "labels", "domain_events"]);
});

test("buildDashboardCommandCenterLanes maps visible resources to metrics and allowed commands", () => {
  const sections = buildDashboardSections(navigationSections, {
    maxItemsPerSection: 5,
    maxSections: 2,
  });
  const commands = [
    {
      key: "shipments.resort",
      label: "Resort shipment",
      capability: "shipments.write",
      schema_category: "resource:shipments",
      execution: { type: "workflow" },
    },
    {
      key: "labels.reprint",
      label: "Reprint label",
      capability: "labels.write",
      schema_category: "resource:labels.reprint",
      execution: { type: "rpc" },
    },
    {
      key: "domain_events.replay",
      label: "Replay event",
      capability: "domain_events.write",
      schema_category: "resource:domain_events",
      execution: { type: "workflow" },
    },
  ];
  const lanes = buildDashboardCommandCenterLanes({
    sections,
    readRegistry: {
      resources: [
        {
          key: "shipments",
          label: "Shipment queue",
          relation: "api.shipments",
          capability_read: "shipments.read",
        },
        {
          key: " labels ",
          label: "Labels",
          relation: "api.labels",
          capability_read: "labels.read",
        },
      ],
    },
    commands,
    capabilities: new Set([
      "shipments.read",
      "shipments.write",
      "labels.write",
    ]),
    resourceCounts: new Map([
      ["shipments", 12],
      ["labels", 3],
    ]),
  });

  expect(lanes).toHaveLength(1);
  expect(lanes[0]).toMatchObject({
    resourceKey: "shipments",
    resourceLabel: "Shipment queue",
    commandCount: 1,
    allowedCommandCount: 1,
    workflowCommandCount: 1,
    metricTotal: 12,
    capability: "shipments.read",
    registryBacked: true,
    readAllowed: true,
  });
});

test("buildDashboardCommandCenterLanes fails closed when read registry is unavailable", () => {
  const sections = buildDashboardSections(navigationSections, {
    maxItemsPerSection: 5,
    maxSections: 2,
  });
  const lanes = buildDashboardCommandCenterLanes({
    sections,
    readRegistry: null,
    commands: [
      {
        key: "shipments.resort",
        label: "Resort shipment",
        capability: "shipments.write",
        schema_category: "resource:shipments",
        execution: { type: "workflow" },
      },
    ],
    capabilities: new Set(["shipments.read", "shipments.write"]),
    resourceCounts: new Map([["shipments", 12]]),
  });

  expect(lanes).toEqual([]);
});

test.each([2, 0, null, undefined])(
  "keeps assigned manual reviews (%p) separate from resource totals",
  (assigned) => {
    const counts = new Map<string, number | null>([
      ["shipments", 12],
      ["manual_review_tasks", 7],
    ]);
    if (assigned !== undefined) counts.set("manual_review_tasks.assigned", assigned);
    const lanes = buildDashboardCommandCenterLanes({
      sections: [{
        id: "ops", label: "Operations", items: [
          { id: "shipments", label: "Shipments", resourceKey: "shipments" },
          { id: "reviews", label: "Reviews", resourceKey: "manual_review_tasks" },
        ],
      }],
      readRegistry: { resources: [
        { key: "shipments", relation: "api.shipments", capability_read: "shipments.read" },
        { key: "manual_review_tasks", relation: "api.manual_review_tasks", capability_read: "manual_review_tasks.read" },
      ] },
      commands: [],
      capabilities: new Set(["shipments.read", "manual_review_tasks.read"]),
      resourceCounts: counts,
    });
    expect(lanes[0]).not.toHaveProperty("assignedMetricTotal");
    expect(lanes[1]?.metricTotal).toBe(7);
    expect(lanes[1]?.assignedMetricTotal).toBe(assigned);
    expect(buildDashboardCommandCenterSummary({ lanes })).toMatchObject({
      laneCount: 2, metricLaneCount: 2, metricReadyCount: 2,
    });
  },
);

test.each([undefined, null, "  "])(
  "buildDashboardCommandCenterLanes fails closed for %p read capability metadata",
  (capabilityRead) => {
    const sections = buildDashboardSections(navigationSections, {
      maxItemsPerSection: 5,
      maxSections: 2,
    });
    const lanes = buildDashboardCommandCenterLanes({
      sections,
      readRegistry: {
        resources: [
          {
            key: "shipments",
            label: "Shipment queue",
            relation: "api.shipments",
            capability_read: capabilityRead,
          },
        ],
      },
      commands: [
        {
          key: "shipments.resort",
          label: "Resort shipment",
          capability: "shipments.write",
          schema_category: "resource:shipments",
          execution: { type: "workflow" },
        },
      ],
      capabilities: new Set(["shipments.read", "shipments.write"]),
      resourceCounts: new Map([["shipments", 12]]),
    });

    expect(lanes).toEqual([]);
  },
);

test("buildDashboardCommandCenterLanes keeps counts aligned with the exact catalog category", () => {
  const sections = buildDashboardSections(navigationSections, {
    maxItemsPerSection: 5,
    maxSections: 2,
  });
  const lanes = buildDashboardCommandCenterLanes({
    sections,
    readRegistry: {
      resources: [
        {
          key: "shipments",
          label: "Shipment queue",
          relation: "api.shipments",
          capability_read: "shipments.read",
        },
      ],
    },
    commands: [
      {
        key: "shipments.open",
        label: "Open shipment",
        capability: "shipments.write",
        schema_category: "resource:shipments",
        execution: { type: "workflow" },
      },
      {
        key: "shipments.bulk",
        label: "Bulk shipments",
        capability: "shipments.write",
        schema_category: "resource:shipments.bulk",
        execution: { type: "workflow" },
      },
      {
        key: "shipments.retry",
        label: "Retry shipment",
        capability: "shipments.write",
        schema_category: "resource/shipments/retry",
        execution: { type: "workflow" },
      },
      {
        key: "shipments.alias",
        label: "Alias shipment",
        capability: "shipments.write",
        schema_category: "resource/shipments",
        execution: { type: "workflow" },
      },
      {
        key: "shipments.bare",
        label: "Bare shipment",
        capability: "shipments.write",
        schema_category: "shipments:print",
        execution: { type: "workflow" },
      },
      {
        key: "shipments.uncategorized",
        label: "Uncategorized shipment",
        capability: "shipments.write",
        schema_category: "operations:shipments",
        execution: { type: "workflow" },
      },
    ],
    capabilities: new Set(["shipments.read", "shipments.write"]),
    resourceCounts: new Map([["shipments", 12]]),
  });

  expect(lanes[0]).toMatchObject({
    resourceKey: "shipments",
    commandCategory: "resource:shipments",
    commandCount: 1,
    allowedCommandCount: 1,
    workflowCommandCount: 1,
  });
});

test("buildDashboardCommandCenterLanes excludes categories the catalog cannot match exactly", () => {
  const sections = buildDashboardSections(navigationSections, {
    maxItemsPerSection: 5,
    maxSections: 2,
  });
  const lanes = buildDashboardCommandCenterLanes({
    sections,
    readRegistry: {
      resources: [
        {
          key: "shipments",
          label: "Shipment queue",
          relation: "api.shipments",
          capability_read: "shipments.read",
        },
      ],
    },
    commands: [
      {
        key: "shipments.padded",
        label: "Padded shipment action",
        capability: "shipments.write",
        schema_category: "  resource:shipments  ",
        execution: { type: "workflow" },
      },
    ],
    capabilities: new Set(["shipments.read", "shipments.write"]),
    resourceCounts: new Map([["shipments", 12]]),
  });

  expect(lanes[0]).toMatchObject({
    resourceKey: "shipments",
    commandCategory: "resource:shipments",
    commandCount: 0,
    allowedCommandCount: 0,
    workflowCommandCount: 0,
  });
});

test("buildDashboardCommandCenterSummary reports workflow and permission coverage", () => {
  const lanes = [
    {
      id: "shipments",
      label: "Shipments",
      href: "/console/resources/shipments",
      resourceKey: "shipments",
      resourceLabel: "Shipments",
      capability: "shipments.read",
      commandCategory: "resource:shipments",
      commandCount: 1,
      allowedCommandCount: 1,
      workflowCommandCount: 1,
      metricTotal: 12,
      registryBacked: true,
      readAllowed: true,
    },
    {
      id: "labels",
      label: "Labels",
      href: "/console/resources/labels",
      resourceKey: "labels",
      resourceLabel: "Labels",
      capability: "labels.read",
      commandCategory: "resource:labels",
      commandCount: 1,
      allowedCommandCount: 0,
      workflowCommandCount: 0,
      metricTotal: null,
      registryBacked: true,
      readAllowed: true,
    },
  ];

  expect(
    buildDashboardCommandCenterSummary({
      lanes,
    }),
  ).toEqual({
    laneCount: 2,
    metricLaneCount: 2,
    metricReadyCount: 1,
    commandCount: 2,
    allowedCommandCount: 1,
    restrictedCommandCount: 1,
    workflowCommandCount: 1,
  });
});

test("buildDashboardCommandCenterSummary excludes unreadable lanes from metric readiness", () => {
  const lanes = [
    {
      id: "shipments",
      label: "Shipments",
      href: "/console/resources/shipments",
      resourceKey: "shipments",
      resourceLabel: "Shipments",
      capability: "shipments.read",
      commandCategory: "resource:shipments",
      commandCount: 1,
      allowedCommandCount: 1,
      workflowCommandCount: 1,
      metricTotal: 12,
      registryBacked: true,
      readAllowed: true,
    },
    {
      id: "labels",
      label: "Labels",
      href: "/console/resources/labels",
      resourceKey: "labels",
      resourceLabel: "Labels",
      capability: "labels.read",
      commandCategory: "resource:labels",
      commandCount: 1,
      allowedCommandCount: 0,
      workflowCommandCount: 0,
      metricTotal: null,
      registryBacked: true,
      readAllowed: false,
    },
  ];

  expect(
    buildDashboardCommandCenterSummary({
      lanes,
    }),
  ).toMatchObject({
    laneCount: 1,
    metricLaneCount: 1,
    metricReadyCount: 1,
  });
});

test("navigation authorization is evaluated before item limits", () => {
  const sections = buildDashboardSections(
    [
      {
        id: "ops",
        label: "Operations",
        items: [
          {
            id: "denied",
            label: "Denied",
            href: "/console/resources/denied",
            resource: "denied",
            capability: "denied.read",
          },
          {
            id: "allowed",
            label: "Allowed",
            href: "/console/resources/allowed",
            resource: "allowed",
            capability: "allowed.read",
          },
        ],
      },
    ],
    {
      capabilities: new Set(["allowed.read"]),
      includeResourceOnly: true,
      maxItemsPerSection: 1,
      maxSections: 1,
    },
  );

  expect(sections[0].items.map((item) => item.id)).toEqual(["allowed"]);
  expect(sections[0].items[0].navigationCapability).toBe("allowed.read");
});

test("identical navigation duplicates fold and conflicting authority fails closed", () => {
  const item = {
    id: "shipments-a",
    label: "Shipments",
    href: "/console/resources/shipments",
    resource: "shipments",
    capability: "shipments.read",
  };
  const identical = buildDashboardSections(
    [
      {
        id: "ops",
        label: "Operations",
        items: [item, { ...item, id: "shipments-b" }],
      },
    ],
    {
      capabilities: new Set(["shipments.read"]),
      includeResourceOnly: true,
    },
  );
  expect(identical[0].items).toHaveLength(1);

  const conflicting = buildDashboardSections(
    [
      {
        id: "ops",
        label: "Operations",
        items: [
          item,
          {
            ...item,
            id: "shipments-admin",
            href: "/console/resources/shipments-admin",
          },
        ],
      },
    ],
    {
      capabilities: new Set(["shipments.read"]),
      includeResourceOnly: true,
    },
  );
  expect(conflicting).toEqual([]);
  expect(
    collectDashboardNavigationAuthorityConflicts([
      {
        id: "ops",
        label: "Operations",
        items: [
          item,
          {
            ...item,
            id: "shipments-admin",
            href: "/console/resources/shipments-admin",
          },
        ],
      },
    ]),
  ).toEqual(["shipments"]);
});

test("navigation resource and href authority must agree", () => {
  const sections = [
    {
      id: "ops",
      label: "Operations",
      items: [
        {
          id: "shipments",
          label: "Shipments",
          href: "/console/resources/orders",
          resource: "shipments",
          capability: "shipments.read",
        },
      ],
    },
  ];

  expect(
    buildDashboardSections(sections, {
      capabilities: new Set(["shipments.read"]),
      includeResourceOnly: true,
    }),
  ).toEqual([]);
  expect(collectDashboardNavigationAuthorityConflicts(sections)).toEqual([
    "shipments",
  ]);
});

test("resource authority folds exact duplicates and rejects conflicting duplicates", () => {
  const resource = {
    key: " Shipments ",
    label: "Shipments",
    relation: " api.shipments ",
    capability_read: " shipments.read ",
  };
  const capabilities = new Set(["shipments.read"]);

  expect(
    resolveDashboardResourceReadState(
      "shipments",
      { resources: [resource, { ...resource }] },
      capabilities,
    ),
  ).toMatchObject({
    registryBacked: true,
    ambiguous: false,
    readAllowed: true,
    capability: "shipments.read",
  });

  expect(
    resolveDashboardResourceReadState(
      "shipments",
      {
        resources: [
          resource,
          { ...resource, relation: "api.shipments_admin" },
        ],
      },
      capabilities,
    ),
  ).toMatchObject({
    registryBacked: false,
    ambiguous: true,
    readAllowed: false,
  });
  expect(
    collectDashboardResourceAuthorityConflicts({
      resources: [resource, { ...resource, relation: "api.shipments_admin" }],
    }),
  ).toEqual(["shipments"]);
  expect(
    resolveDashboardResourceReadState(
      "shipments",
      { resources: [] },
      new Set(["*"]),
    ),
  ).toMatchObject({
    registryBacked: false,
    ambiguous: false,
    readAllowed: false,
    resource: null,
  });
});

test("ambiguous child authority cannot fall back to a readable parent command binding", () => {
  const command = {
    key: "shipment-items.retry",
    label: "Retry shipment item",
    capability: "shipments.write",
    schema_category: "resource:shipments.items:retry",
    execution: { type: "workflow" as const },
  };
  const registry = {
    resources: [
      {
        key: "shipments",
        relation: "api.shipments",
        capability_read: "shipments.read",
      },
      {
        key: "shipments.items",
        relation: "api.shipment_items",
        capability_read: "shipment_items.read",
      },
      {
        key: "shipments.items",
        relation: "api.shipment_items_admin",
        capability_read: "shipment_items.read",
      },
    ],
  };
  const capabilities = new Set([
    "shipments.read",
    "shipment_items.read",
    "shipments.write",
  ]);

  expect(
    commandResourceReadAllowed(command, registry, capabilities),
  ).toBe(false);

  const lanes = buildDashboardCommandCenterLanes({
    sections: [
      {
        id: "ops",
        label: "Operations",
        items: [
          {
            id: "shipments",
            label: "Shipments",
            href: "/console/resources/shipments",
            resourceKey: "shipments",
            navigationCapability: "shipments.read",
          },
        ],
      },
    ],
    readRegistry: registry,
    commands: [command],
    capabilities,
    resourceCounts: new Map([["shipments", 12]]),
  });

  expect(lanes[0]).toMatchObject({
    resourceKey: "shipments",
    commandCount: 0,
    allowedCommandCount: 0,
    workflowCommandCount: 0,
  });
});

test("wildcard read authority is accepted while missing metadata remains denied", () => {
  const registry = {
    resources: [
      {
        key: "shipments",
        relation: "api.shipments",
        capability_read: "shipments.read",
      },
    ],
  };
  expect(
    resolveDashboardResourceReadState(
      "shipments",
      registry,
      new Set(["*"]),
    ).readAllowed,
  ).toBe(true);
  expect(
    resolveDashboardResourceReadState(
      "shipments",
      {
        resources: [{ ...registry.resources[0], capability_read: " " }],
      },
      new Set(["*"]),
    ).readAllowed,
  ).toBe(false);
  expect(
    resolveDashboardResourceReadState(
      "shipments",
      {
        resources: [{ ...registry.resources[0], relation: " " }],
      },
      new Set(["*"]),
    ).readAllowed,
  ).toBe(false);
});

test("command duplicate authority folds exact rows and excludes conflicts", () => {
  const command = {
    key: " Shipments.Resort ",
    label: "Resort",
    capability: " shipments.write ",
    schema_category: " resource:shipments ",
    execution: { type: "workflow" as const },
  };
  expect(normalizeDashboardCommands([command, { ...command }])).toEqual([
    expect.objectContaining({
      key: "shipments.resort",
      capability: "shipments.write",
      schema_category: " resource:shipments ",
    }),
  ]);
  expect(
    normalizeDashboardCommands([
      command,
      { ...command, capability: "shipments.admin" },
    ]),
  ).toEqual([]);
  expect(
    collectDashboardCommandAuthorityConflicts([
      command,
      { ...command, capability: "shipments.admin" },
    ]),
  ).toEqual(["shipments.resort"]);
  expect(normalizeDashboardCommands([])).toEqual([]);
  expect(collectDashboardCommandAuthorityConflicts([])).toEqual([]);
});

test("section selection filters unreadable candidates before truncation", () => {
  const sections = [
    {
      id: "ops",
      label: "Operations",
      items: [
        { id: "denied", label: "Denied", resourceKey: "denied" },
        { id: "allowed", label: "Allowed", resourceKey: "allowed" },
      ],
    },
  ];
  expect(
    selectDashboardSections(sections, {
      includeItem: (item) => item.resourceKey === "allowed",
      maxItemsPerSection: 1,
      maxSections: 1,
    })[0].items.map((item) => item.id),
  ).toEqual(["allowed"]);
});
