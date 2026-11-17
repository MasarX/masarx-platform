import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { getVerifiedUser } from "@masarx/auth";
import { createUiServerClient } from "@masarx/api/server";
import { DashboardPage } from "../../packages/ui/src/dashboard-page";
import messages from "../../packages/config/messages/en.json";
import arMessages from "../../packages/config/messages/ar.json";

jest.mock("@masarx/auth", () => ({
  getVerifiedUser: jest.fn(),
}));

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

jest.mock(
  "tailwind-merge",
  () => ({
    twMerge: (value: string) => value,
  }),
  { virtual: true },
);

const mockedGetVerifiedUser = getVerifiedUser as jest.Mock;
const mockedCreateUiServerClient = createUiServerClient as jest.Mock;

function createAuthenticatedSession() {
  mockedGetVerifiedUser.mockResolvedValue({
    user: { id: "user-1", email: "ops@example.com" },
  });
}

function createUiClientMock(overrides: Record<string, unknown> = {}) {
  return {
    context: jest.fn().mockResolvedValue({
      me: {
        user: {
          id: "user-1",
          email: "ops@example.com",
          user_type: "tenant_operator",
        },
        org: { id: "org-1", name: "MasarX Ops" },
        access_scope: {
          scope_type: "tenant",
          scope_id: "tenant-1",
          scope_label: "Tenant A",
        },
        capabilities: [
          "shipments.read",
          "shipments.write",
          "manual_review_tasks.read",
          "manual_review_tasks.write",
        ],
        settings_resolution_id: "settings-resolution-1",
      },
      navigation: {
        sections: [
          {
            id: "ops",
            label: "Operations",
            items: [
              {
                id: "shipments",
                label: "Shipments",
                href: "/console/console/resources/shipments",
              },
              {
                id: "manual-review",
                label: "Manual review queue",
                href: "/console/resources/manual_review_tasks",
              },
            ],
          },
        ],
      },
    }),
    dashboardConfig: jest.fn().mockResolvedValue({
      max_sections: 4,
      max_items_per_section: 6,
      max_actions: 4,
      max_metrics: 6,
    }),
    commandRegistry: jest.fn().mockResolvedValue({
      commands: [
        {
          key: "shipments.resort",
          label: "Resort shipment",
          description: "Re-run shipment sorting",
          capability: "shipments.write",
          schema_category: "resource:shipments",
          execution: { type: "workflow_binding" },
          route_targets: {
            console: { path: "/commands?category=resource%3Ashipments" },
          },
        },
        {
          key: "manual_review.resolve",
          label: "Resolve review",
          description: "Resolve a manual review task",
          capability: "manual_review_tasks.write",
          schema_category: "resource:manual_review_tasks",
          execution: { type: "workflow" },
          route_targets: {
            console: { path: "/workflows/queue" },
          },
        },
      ],
    }),
    readRegistry: jest.fn().mockResolvedValue({
      resources: [
        {
          key: " shipments ",
          label: "Shipment queue",
          relation: "api.shipments",
          capability_read: "shipments.read",
        },
        {
          key: "manual_review_tasks",
          label: "Manual review queue",
          relation: "api.manual_review_tasks",
          capability_read: "manual_review_tasks.read",
        },
      ],
    }),
    dashboardMetrics: jest.fn().mockResolvedValue({
      metrics: [
        { resource: " shipments ", total: 12 },
        { resource: "manual_review_tasks", total: 3 },
      ],
    }),
    listResource: jest.fn().mockResolvedValue({
      resource: "shipments",
      items: [],
      limit: 1,
      offset: 0,
      total: 0,
    }),
    ...overrides,
  };
}

describe("DashboardPage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("skips context calls when there is no session", async () => {
    mockedGetVerifiedUser.mockResolvedValue({ user: null });

    const result = await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    });

    expect(result).toBeNull();
    expect(mockedCreateUiServerClient).not.toHaveBeenCalled();
  });

  it("renders registry-backed command-center lanes with metrics and workflow commands", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock();
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const result = await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    });

    render(result as ReactElement);

    expect(screen.getByTestId("console-dashboard-ready")).toBeInTheDocument();
    expect(
      screen.getByTestId("console-dashboard-command-center"),
    ).toBeInTheDocument();
    expect(screen.getByText("Command center")).toBeInTheDocument();
    expect(screen.getByText("Shipment queue")).toBeInTheDocument();
    expect(screen.getAllByText("Manual review queue").length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("12 records").length).toBeGreaterThan(0);
    expect(screen.getAllByText("3 records").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1/1 commands").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: "Open lane: Shipment queue" }),
    ).toHaveAttribute("href", "/console/resources/shipments");
    expect(
      screen.getByRole("link", { name: "Open lane: Manual review queue" }),
    ).toHaveAttribute("href", "/console/resources/manual_review_tasks");

    expect(
      screen.getByRole("link", { name: "Open commands: Shipment queue" }),
    ).toHaveAttribute(
      "href",
      "/console/commands?category=resource%3Ashipments&access=allowed",
    );
    expect(
      screen.getByRole("link", { name: "Open commands: Manual review queue" }),
    ).toHaveAttribute(
      "href",
      "/console/commands?category=resource%3Amanual_review_tasks&access=allowed",
    );
    expect(uiClient.dashboardMetrics).toHaveBeenCalledWith([
      "shipments",
      "manual_review_tasks",
    ]);
  });

  it.each([
    ["en", messages, "My Day", "2 assigned to you"],
    ["ar", arMessages, "يومي", "2 مُسندة إليك"],
  ] as const)(
    "keeps the current operator's My Day count separate from all reviews in %s",
    async (locale, localizedMessages, title, assignedLabel) => {
      createAuthenticatedSession();
      const uiClient = createUiClientMock({
        dashboardMetrics: jest.fn().mockResolvedValue({
          metrics: [
            { resource: "shipments", total: 12 },
            { resource: "manual_review_tasks", total: 7 },
          ],
        }),
        listResource: jest.fn().mockResolvedValue({ items: [], total: 2 }),
      });
      mockedCreateUiServerClient.mockReturnValue(uiClient);

      render((await DashboardPage({
        appLabel: "Console",
        appKey: "console",
        appBasePath: "/console",
        testIdPrefix: "console-dashboard",
        locale,
        messages: localizedMessages,
      })) as ReactElement);

      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.getByText(assignedLabel)).toBeInTheDocument();
      expect(screen.getAllByText(locale === "en" ? "7 records" : /7 سجل/).length)
        .toBeGreaterThan(0);
      expect(uiClient.listResource).toHaveBeenCalledTimes(1);
      expect(uiClient.listResource).toHaveBeenCalledWith(
        "manual_review_tasks", { assigned_to: "user-1" }, 1, 0, null,
      );
    },
  );

  it("starts My Day readback while aggregate metrics are still pending", async () => {
    createAuthenticatedSession();
    let finishMetrics!: () => void;
    const uiClient = createUiClientMock({
      dashboardMetrics: jest.fn().mockImplementation(() => new Promise((resolve) => {
        finishMetrics = () => resolve({ metrics: [
          { resource: "shipments", total: 12 },
          { resource: "manual_review_tasks", total: 7 },
        ] });
      })),
      listResource: jest.fn().mockResolvedValue({ items: [], total: 2 }),
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);
    const page = DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    });
    try {
      await waitFor(() => expect(uiClient.listResource).toHaveBeenCalled());
    } finally {
      finishMetrics();
    }
    render((await page) as ReactElement);
    expect(screen.getByText("2 assigned to you")).toBeInTheDocument();
  });

  it.each([
    ["a true zero", { items: [], total: 0 }, "0 assigned to you"],
    ["the list fallback", { items: [{ id: "review-1" }] }, "1 assigned to you"],
  ])("renders %s for My Day without using the all-task total", async (_case, list, label) => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock({
      listResource: jest.fn().mockResolvedValue(list),
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);
    render((await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    })) as ReactElement);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("keeps a failed My Day readback unavailable instead of borrowing the all-task count", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock({
      listResource: jest.fn().mockRejectedValue(new Error("assigned reviews offline")),
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);
    render((await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    })) as ReactElement);
    expect(screen.getByText("Metric pending assigned to you")).toBeInTheDocument();
    expect(screen.getByText("Your assigned-review count could not be loaded."))
      .toBeInTheDocument();
    expect(screen.queryByText("0 assigned to you")).not.toBeInTheDocument();
    expect(screen.queryByText("3 assigned to you")).not.toBeInTheDocument();
    expect(screen.getAllByText("3 records").length).toBeGreaterThan(0);
  });

  it.each([null, ""])("does not query or show My Day without a context user ID (%p)", async (id) => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock();
    const context = await uiClient.context();
    context.me.user.id = id;
    mockedCreateUiServerClient.mockReturnValue(uiClient);
    render((await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    })) as ReactElement);
    expect(screen.queryByText("My Day")).not.toBeInTheDocument();
    expect(uiClient.listResource).not.toHaveBeenCalled();
  });

  it("does not read assigned reviews when manual-review permission is denied", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock();
    const context = await uiClient.context();
    context.me.capabilities = ["shipments.read"];
    mockedCreateUiServerClient.mockReturnValue(uiClient);
    render((await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    })) as ReactElement);
    expect(screen.queryByText("My Day")).not.toBeInTheDocument();
    expect(uiClient.dashboardMetrics).toHaveBeenCalledWith(["shipments"]);
    expect(uiClient.listResource).not.toHaveBeenCalled();
  });

  it("uses broad resource matching for actions while lane counts stay catalog-exact", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock({
      dashboardConfig: jest.fn().mockResolvedValue({
        max_sections: 4,
        max_items_per_section: 6,
        max_actions: 6,
        max_metrics: 6,
      }),
      commandRegistry: jest.fn().mockResolvedValue({
        commands: [
          "shipments",
          "shipments.bulk",
          "resource/shipments/retry",
          "resource.shipments:resort",
          "resource:shipments/actions",
        ].map((schema_category, index) => ({
          key: `shipments.action-${index}`,
          label: `Shipment action ${index}`,
          capability: "shipments.write",
          schema_category,
          execution: { type: "workflow" },
          route_targets: {
            console: { path: `/commands?action=${index}` },
          },
        })),
      }),
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const result = await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    });

    render(result as ReactElement);

    expect(screen.getAllByRole("link", { name: "Start request" })).toHaveLength(
      5,
    );
    expect(screen.getAllByText("1/1 commands")).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "Open commands: Shipment queue" }),
    ).toHaveAttribute(
      "href",
      "/console/commands?category=resource%3Ashipments%2Factions&access=allowed",
    );
  });

  it("keeps padded command categories out of exact catalog links", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock({
      commandRegistry: jest.fn().mockResolvedValue({
        commands: [
          {
            key: "shipments.padded",
            label: "Padded shipment action",
            capability: "shipments.write",
            schema_category: "  resource:shipments  ",
            execution: { type: "workflow" },
            route_targets: {
              console: { path: "/commands?action=padded" },
            },
          },
        ],
      }),
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const result = await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    });

    render(result as ReactElement);

    expect(screen.getAllByText("0/0 commands").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("link", { name: "Open commands: Shipment queue" }),
    ).not.toBeInTheDocument();
  });

  it("prioritizes allowed quick actions before applying the action limit", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock({
      dashboardConfig: jest.fn().mockResolvedValue({
        max_sections: 4,
        max_items_per_section: 6,
        max_actions: 1,
        max_metrics: 6,
      }),
      commandRegistry: jest.fn().mockResolvedValue({
        commands: [
          {
            key: "shipments.restricted",
            label: "A restricted action",
            capability: "shipments.admin",
            schema_category: "resource:shipments",
            execution: { type: "workflow" },
            route_targets: {
              console: { path: "/commands?action=restricted" },
            },
          },
          {
            key: "shipments.allowed",
            label: "Z allowed action",
            capability: "shipments.write",
            schema_category: "resource:shipments",
            execution: { type: "workflow" },
            route_targets: {
              console: { path: "/commands?action=allowed" },
            },
          },
        ],
      }),
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const result = await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    });

    render(result as ReactElement);

    expect(screen.getByText("Z allowed action")).toBeInTheDocument();
    expect(screen.queryByText("A restricted action")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Start request" }),
    ).toHaveAttribute("href", "/console/commands?action=allowed");
  });

  it.each([
    ["console", "/console", "/portal/resources/shipments"],
    ["portal", "/portal", "/console/resources/shipments"],
  ])(
    "fails %s quick-action command routes closed outside the app boundary",
    async (appKey, appBasePath, otherAppPath) => {
      createAuthenticatedSession();
      const unsafePaths = [
        `${appBasePath}/../outside`,
        `${appBasePath}/%2e%2e/outside`,
        `${appBasePath}/safe%2f..%2foutside`,
        `${appBasePath}x/commands`,
        "//outside.example/commands",
        "https://outside.example/commands",
        otherAppPath,
      ];
      const uiClient = createUiClientMock({
        commandRegistry: jest.fn().mockResolvedValue({
          commands: [
            {
              key: "shipments.safe",
              label: "Safe shipment command",
              capability: "shipments.write",
              schema_category: "resource:shipments",
              execution: { type: "workflow" },
              route_targets: {
                [appKey]: { path: "/commands?safe=1" },
              },
            },
            ...unsafePaths.map((path, index) => ({
              key: `shipments.unsafe-route-${index}`,
              label: `Unsafe route ${index}`,
              capability: "shipments.write",
              schema_category: "resource:shipments",
              execution: { type: "workflow" },
              route_targets: { [appKey]: { path } },
            })),
            {
              key: "shipments.unsafe-href",
              label: "Unsafe fallback href",
              capability: "shipments.write",
              schema_category: "resource:shipments",
              execution: { type: "workflow" },
              href: `${appBasePath}/../outside`,
            },
          ],
        }),
      });
      mockedCreateUiServerClient.mockReturnValue(uiClient);

      const result = await DashboardPage({
        appLabel: appKey === "console" ? "Console" : "Portal",
        appKey,
        appBasePath,
        testIdPrefix: `${appKey}-dashboard`,
        messages,
      });

      render(result as ReactElement);

      expect(screen.getByText("Safe shipment command")).toBeInTheDocument();
      const startLinks = screen.getAllByRole("link", {
        name: "Start request",
      });
      expect(startLinks).toHaveLength(1);
      expect(startLinks[0]).toHaveAttribute(
        "href",
        `${appBasePath}/commands?safe=1`,
      );
      unsafePaths.forEach((_path, index) => {
        expect(
          screen.queryByText(`Unsafe route ${index}`),
        ).not.toBeInTheDocument();
      });
      expect(
        screen.queryByText("Unsafe fallback href"),
      ).not.toBeInTheDocument();
    },
  );

  it.each([
    [
      "the user lacks the registry read capability",
      ["shipments.write"],
      true,
      "shipments.read",
    ],
    [
      "registry read-capability metadata is missing",
      ["shipments.read", "shipments.write"],
      true,
      null,
    ],
    [
      "registry read-capability metadata is blank",
      ["shipments.read", "shipments.write"],
      true,
      "  ",
    ],
    [
      "the resource is missing from the read registry",
      ["shipments.read", "shipments.write"],
      false,
      "shipments.read",
    ],
  ])(
    "fails command actions closed when %s",
    async (_case, capabilities, registryBacked, capabilityRead) => {
      createAuthenticatedSession();
      const uiClient = createUiClientMock({
        commandRegistry: jest.fn().mockResolvedValue({
          commands: [
            "shipments.bulk",
            "resource/shipments/retry",
            "resource.shipments:resort",
          ].map((schema_category, index) => ({
            key: `shipments.action-${index}`,
            label: `Shipment action ${index}`,
            capability: "shipments.write",
            schema_category,
            execution: { type: "workflow" },
            route_targets: {
              console: { path: `/commands?action=${index}` },
            },
          })),
        }),
        readRegistry: jest.fn().mockResolvedValue({
          resources: registryBacked
            ? [
                {
                  key: "shipments",
                  label: "Shipment queue",
                  relation: "api.shipments",
                  capability_read: capabilityRead,
                },
              ]
            : [],
        }),
      });
      const context = await uiClient.context();
      context.me.capabilities = capabilities;
      uiClient.context.mockResolvedValue(context);
      mockedCreateUiServerClient.mockReturnValue(uiClient);

      const result = await DashboardPage({
        appLabel: "Console",
        appKey: "console",
        appBasePath: "/console",
        testIdPrefix: "console-dashboard",
        messages,
      });

      render(result as ReactElement);

      expect(
        screen.queryByRole("link", { name: "Start request" }),
      ).not.toBeInTheDocument();
      expect(screen.getAllByText("Restricted")).toHaveLength(3);
      expect(
        screen.queryByRole("link", { name: /Open lane:/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: /Open commands:/ }),
      ).not.toBeInTheDocument();
      expect(uiClient.dashboardMetrics).not.toHaveBeenCalled();
      expect(uiClient.listResource).not.toHaveBeenCalled();
    },
  );

  it("keeps command controls hidden when command registry readback is degraded", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock({
      commandRegistry: jest.fn().mockRejectedValue({}),
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const result = await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    });

    render(result as ReactElement);

    expect(
      screen.getByTestId("console-dashboard-command-center-degraded"),
    ).toBeInTheDocument();
    expect(screen.getByText("Command registry:")).toBeInTheDocument();
    expect(
      screen.getByText("Unable to load dashboard command registry."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText("Command registry did not return workflow coverage."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Command registry did not return permission coverage."),
    ).toBeInTheDocument();
    expect(screen.queryByText("0/0")).not.toBeInTheDocument();
    expect(screen.queryByText("0/0 commands")).not.toBeInTheDocument();
    expect(
      screen.queryByText("0 restricted for this session."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("1/1 commands")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open commands" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Start request" }),
    ).not.toBeInTheDocument();
  });

  it("renders registry-backed resource-only command-center lanes without lane links", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock();
    uiClient.context.mockResolvedValue({
      me: {
        user: {
          id: "user-1",
          email: "ops@example.com",
          user_type: "tenant_operator",
        },
        org: { id: "org-1", name: "MasarX Ops" },
        access_scope: {
          scope_type: "tenant",
          scope_id: "tenant-1",
          scope_label: "Tenant A",
        },
        capabilities: ["manual_review_tasks.read", "manual_review_tasks.write"],
        settings_resolution_id: "settings-resolution-1",
      },
      navigation: {
        sections: [
          {
            id: "ops",
            label: "Operations",
            items: [
              {
                id: "manual-review",
                label: "Manual review",
                resource: "manual_review_tasks",
              },
            ],
          },
        ],
      },
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const result = await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    });

    render(result as ReactElement);

    expect(screen.getByText("Manual review queue")).toBeInTheDocument();
    expect(screen.getAllByText("3 records").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("link", { name: "Open lane: Manual review queue" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open commands: Manual review queue" }),
    ).toHaveAttribute(
      "href",
      "/console/commands?category=resource%3Amanual_review_tasks&access=allowed",
    );
    expect(uiClient.dashboardMetrics).toHaveBeenCalledWith([
      "manual_review_tasks",
    ]);
  });

  it("does not render unsafe command-center lane links as clickable controls", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock();
    uiClient.context.mockResolvedValue({
      me: {
        user: {
          id: "user-1",
          email: "ops@example.com",
          user_type: "tenant_operator",
        },
        org: { id: "org-1", name: "MasarX Ops" },
        access_scope: {
          scope_type: "tenant",
          scope_id: "tenant-1",
          scope_label: "Tenant A",
        },
        capabilities: ["shipments.read", "shipments.write"],
        settings_resolution_id: "settings-resolution-1",
      },
      navigation: {
        sections: [
          {
            id: "ops",
            label: "Operations",
            items: [
              {
                id: "shipments",
                label: "Shipments",
                href: "javascript:alert(1)",
                resource: "shipments",
              },
            ],
          },
        ],
      },
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const result = await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    });

    const { container } = render(result as ReactElement);

    expect(screen.getByText("Shipment queue")).toBeInTheDocument();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Open lane" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: "Open commands: Shipment queue" }),
    ).toHaveAttribute(
      "href",
      "/console/commands?category=resource%3Ashipments&access=allowed",
    );
  });

  it.each([
    [
      "console",
      "/console",
      "/console/console/resources/shipments",
      "/portal/outside",
    ],
    [
      "portal",
      "/portal",
      "/portal/portal/resources/shipments",
      "/console/outside",
    ],
  ])(
    "canonicalizes %s navigation inside its app base and rejects escapes",
    async (appKey, appBasePath, containedHref, otherAppHref) => {
      createAuthenticatedSession();
      const uiClient = createUiClientMock({
        dashboardConfig: jest.fn().mockResolvedValue({
          max_sections: 4,
          max_items_per_section: 20,
          max_actions: 4,
          max_metrics: 20,
        }),
      });
      const context = await uiClient.context();
      context.navigation.sections[0].items = [
        {
          id: "contained",
          label: "Contained shipments",
          href: containedHref,
          resource: "shipments",
        },
        {
          id: "literal-escape",
          label: "Literal escape",
          href: `${appBasePath}/../outside`,
        },
        {
          id: "encoded-escape",
          label: "Encoded escape",
          href: `${appBasePath}/%2e%2e/outside`,
        },
        {
          id: "nested-encoded-escape",
          label: "Nested encoded escape",
          href: `${appBasePath}/%2525252e%2525252e/outside`,
        },
        {
          id: "encoded-separator-escape",
          label: "Encoded separator escape",
          href: `${appBasePath}/safe%2f..%2foutside`,
        },
        {
          id: "encoded-backslash-escape",
          label: "Encoded backslash escape",
          href: `${appBasePath}/safe%5c..%5coutside`,
        },
        {
          id: "control-character",
          label: "Control character escape",
          href: `${appBasePath}/safe\tpath`,
        },
        {
          id: "base-lookalike",
          label: "Base lookalike escape",
          href: `${appBasePath}x/outside`,
        },
        {
          id: "scheme-relative",
          label: "Scheme-relative escape",
          href: "//outside.example/outside",
        },
        {
          id: "cross-origin",
          label: "Cross-origin escape",
          href: "https://outside.example/outside",
        },
        {
          id: "other-app",
          label: "Other app escape",
          href: otherAppHref,
        },
      ];
      uiClient.context.mockResolvedValue(context);
      mockedCreateUiServerClient.mockReturnValue(uiClient);

      const result = await DashboardPage({
        appLabel: appKey === "console" ? "Console" : "Portal",
        appKey,
        appBasePath,
        testIdPrefix: `${appKey}-dashboard`,
        messages,
      });

      render(result as ReactElement);

      expect(
        screen.getByText("Contained shipments").closest("a"),
      ).toHaveAttribute("href", `${appBasePath}/resources/shipments`);
      expect(screen.queryByText("Literal escape")).not.toBeInTheDocument();
      expect(screen.queryByText("Encoded escape")).not.toBeInTheDocument();
      expect(
        screen.queryByText("Nested encoded escape"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Encoded separator escape"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Encoded backslash escape"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Control character escape"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Base lookalike escape"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Scheme-relative escape"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Cross-origin escape"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Other app escape")).not.toBeInTheDocument();
    },
  );

  it("does not render command-center lane links when read permission is missing", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock();
    uiClient.context.mockResolvedValue({
      me: {
        user: {
          id: "user-1",
          email: "ops@example.com",
          user_type: "tenant_operator",
        },
        org: { id: "org-1", name: "MasarX Ops" },
        access_scope: {
          scope_type: "tenant",
          scope_id: "tenant-1",
          scope_label: "Tenant A",
        },
        capabilities: ["shipments.write"],
        settings_resolution_id: "settings-resolution-1",
      },
      navigation: {
        sections: [
          {
            id: "ops",
            label: "Operations",
            items: [
              {
                id: "shipments",
                label: "Shipments",
                href: "/console/resources/shipments",
              },
            ],
          },
        ],
      },
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const result = await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    });

    const { container } = render(result as ReactElement);

    expect(
      screen.getByText("No operator lanes are visible for this scope."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open lane" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("0/1 commands")).not.toBeInTheDocument();
    expect(screen.queryByText("0/0 commands")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open commands" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Restricted").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("link", { name: "Start request" }),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('a[href="/console/resources/shipments"]'),
    ).toBeNull();
    expect(screen.queryByText("Metric readback:")).not.toBeInTheDocument();
    expect(uiClient.dashboardMetrics).not.toHaveBeenCalled();
    expect(uiClient.listResource).not.toHaveBeenCalled();
  });

  it("does not render command-center lane controls for resources missing from the read registry", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock({
      readRegistry: jest.fn().mockResolvedValue({ resources: [] }),
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const result = await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    });

    const { container } = render(result as ReactElement);

    expect(
      screen.getByText("No operator lanes are visible for this scope."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open lane" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open commands" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("0/0 commands")).not.toBeInTheDocument();
    expect(screen.getAllByText("Restricted").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("link", { name: "Start request" }),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('a[href="/console/resources/shipments"]'),
    ).toBeNull();
    expect(screen.queryByText("Metric readback:")).not.toBeInTheDocument();
    expect(uiClient.dashboardMetrics).not.toHaveBeenCalled();
    expect(uiClient.listResource).not.toHaveBeenCalled();
  });

  it("keeps the dashboard usable when a registry readback is degraded", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock({
      readRegistry: jest.fn().mockRejectedValue({}),
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const result = await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    });

    const { container } = render(result as ReactElement);

    expect(
      screen.getByTestId("console-dashboard-command-center-degraded"),
    ).toBeInTheDocument();
    expect(screen.getByText("Read registry:")).toBeInTheDocument();
    expect(
      screen.getByText("Unable to load dashboard read registry."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No operator lanes are visible for this scope."),
    ).toBeInTheDocument();
    expect(screen.queryByText("12 records")).not.toBeInTheDocument();
    expect(screen.queryByText("3 records")).not.toBeInTheDocument();
    expect(screen.queryByText("0/0 commands")).not.toBeInTheDocument();
    expect(screen.getAllByText("Restricted").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("link", { name: "Open lane" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open commands" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Start request" }),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('a[href="/console/resources/shipments"]'),
    ).toBeNull();
    expect(uiClient.dashboardMetrics).not.toHaveBeenCalled();
    expect(uiClient.listResource).not.toHaveBeenCalled();
  });

  it("filters navigation capability before metrics and presentation limits", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock();
    const context = await uiClient.context();
    uiClient.context.mockResolvedValue({
      ...context,
      navigation: {
        sections: [
          {
            id: "ops",
            label: "Operations",
            items: [
              {
                id: "shipments",
                label: "Shipments",
                href: "/console/resources/shipments",
                resource: "shipments",
                capability: "shipments.navigation",
              },
            ],
          },
        ],
      },
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const result = await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      maxItemsPerSection: 1,
      messages,
    });

    render(result as ReactElement);

    expect(
      screen.getByText("No operator lanes are visible for this scope."),
    ).toBeInTheDocument();
    expect(screen.getByText("Navigation modules load once capabilities are assigned.")).toBeInTheDocument();
    expect(uiClient.dashboardMetrics).not.toHaveBeenCalled();
    expect(uiClient.listResource).not.toHaveBeenCalled();
  });

  it("fails conflicting duplicate resource authority closed", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock({
      readRegistry: jest.fn().mockResolvedValue({
        resources: [
          {
            key: "shipments",
            label: "Shipment queue",
            relation: "api.shipments",
            capability_read: "shipments.read",
          },
          {
            key: " shipments ",
            label: "Shipment admin",
            relation: "api.shipments_admin",
            capability_read: "shipments.read",
          },
        ],
      }),
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const result = await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    });

    render(result as ReactElement);

    expect(
      screen.getByText("No operator lanes are visible for this scope."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Shipment queue")).not.toBeInTheDocument();
    expect(screen.queryByText("Shipment admin")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("console-dashboard-command-center-degraded"),
    ).toBeInTheDocument();
    expect(screen.getByText("Registry authority conflicts:")).toBeInTheDocument();
    expect(
      screen.getByText("Conflicting registry definitions excluded: 1."),
    ).toBeInTheDocument();
    expect(uiClient.dashboardMetrics).not.toHaveBeenCalled();
    expect(uiClient.listResource).not.toHaveBeenCalled();
  });

  it("marks metric readback for review when queue metrics are unavailable", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock({
      dashboardMetrics: jest
        .fn()
        .mockRejectedValue(new Error("metrics offline")),
      listResource: jest.fn().mockRejectedValue(new Error("resource offline")),
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const result = await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
      messages,
    });

    render(result as ReactElement);

    expect(
      screen.getByTestId("console-dashboard-command-center-degraded"),
    ).toBeInTheDocument();
    expect(screen.getByText("Metric readback:")).toBeInTheDocument();
    expect(
      screen.getByText("0/2 visible lanes returned metrics."),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Metric pending records").length,
    ).toBeGreaterThan(0);
    expect(uiClient.listResource).toHaveBeenCalledTimes(3);
  });
});
