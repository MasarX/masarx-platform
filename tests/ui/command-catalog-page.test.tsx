import { screen } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import { CommandCatalogPage } from "../../packages/ui/src/command-catalog-page";

jest.mock("next/navigation", () => ({
  usePathname: () => "/commands",
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(() => ({
    me: jest.fn().mockResolvedValue({ capabilities: [] }),
    readRegistry: jest.fn().mockResolvedValue({
      resources: [
        {
          key: "shipments", relation: "api.shipments",
          label: "Shipments",
          capability_read: "shipments.read"
        }
      ]
    })
  }))
}));

jest.mock("../../packages/ui/src/command-registry", () => ({
  fetchCommandRegistry: jest.fn()
}));

const { fetchCommandRegistry } = jest.requireMock(
  "../../packages/ui/src/command-registry"
) as { fetchCommandRegistry: jest.Mock };

beforeEach(() => {
  fetchCommandRegistry.mockReset();
});

test("command catalog shows empty state when no commands", async () => {
  fetchCommandRegistry.mockResolvedValue({ commands: [], error: null });

  const element = await CommandCatalogPage({
    appKey: "console",
    appLabel: "Console",
    testIdPrefix: "console-commands",
    appBasePath: "/console"
  });

  renderWithIntl(element as React.ReactElement);

  expect(
    screen.getByText("No commands configured for this scope.")
  ).toBeInTheDocument();
});

test("command catalog stays navigable when command registry readback is degraded", async () => {
  fetchCommandRegistry.mockResolvedValue({
    commands: [],
    error: new Error("registry offline")
  });

  const element = await CommandCatalogPage({
    appKey: "console",
    appLabel: "Console",
    testIdPrefix: "console-commands",
    appBasePath: "/console"
  });

  renderWithIntl(element as React.ReactElement);

  const status = screen.getByRole("status", {
    name: "Command catalog status"
  });
  expect(status).toHaveAttribute("data-testid", "console-commands-degraded");
  expect(status).toHaveAttribute("aria-live", "polite");
  expect(status).toHaveAttribute("aria-atomic", "true");
  expect(screen.getByText("Unable to load command catalog.")).toBeInTheDocument();
  expect(screen.queryByText("registry offline", { exact: false })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Search commands")).toBeInTheDocument();
  expect(
    screen.getByText("Command registry readback is unavailable.")
  ).toBeInTheDocument();
  expect(
    screen.queryByText("No commands configured for this scope.")
  ).not.toBeInTheDocument();
  expect(screen.queryByTestId("console-commands-error")).not.toBeInTheDocument();
});

test("command catalog shows filtered empty state", async () => {
  fetchCommandRegistry.mockResolvedValue({
    commands: [
      {
        key: "shipments.create",
        label: "Create shipment",
        workflow_key: "shipments.create",
        schema_category: "resource:shipments"
      }
    ],
    error: null
  });

  const element = await CommandCatalogPage({
    appKey: "console",
    appLabel: "Console",
    testIdPrefix: "console-commands",
    appBasePath: "/console",
    searchParams: { q: "missing" }
  });

  renderWithIntl(element as React.ReactElement);

  expect(
    screen.getByText("No commands match the current filters.")
  ).toBeInTheDocument();
});

test("command catalog allowed filter excludes commands without an app route target", async () => {
  fetchCommandRegistry.mockResolvedValue({
    commands: [
      {
        key: "shipments.print_labels",
        label: "Print labels",
        capability: "shipments.write",
        schema_category: "resource:shipments",
        href: "/commands/request/shipments.print_labels",
        route_targets: {
          portal: { path: "/commands/request/shipments.print_labels" }
        }
      },
      {
        key: "shipments.resort",
        label: "Resort shipment",
        capability: "shipments.write",
        schema_category: "resource:shipments",
        route_targets: {
          console: { path: "/commands/request/shipments.resort" }
        }
      }
    ],
    error: null
  });
  const { createUiServerClient } = jest.requireMock("@masarx/api/server") as {
    createUiServerClient: jest.Mock;
  };
  createUiServerClient.mockReturnValue({
    me: jest.fn().mockResolvedValue({
      capabilities: ["shipments.read", "shipments.write"]
    }),
    readRegistry: jest.fn().mockResolvedValue({
      resources: [
        {
          key: "shipments", relation: "api.shipments",
          label: "Shipments",
          capability_read: "shipments.read"
        }
      ]
    })
  });

  const element = await CommandCatalogPage({
    appKey: "console",
    appLabel: "Console",
    testIdPrefix: "console-commands",
    appBasePath: "/console",
    searchParams: { access: "allowed" }
  });

  renderWithIntl(element as React.ReactElement);

  expect(screen.getByText("Resort shipment")).toBeInTheDocument();
  expect(screen.queryByText("Print labels")).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Open request" })
  ).toHaveAttribute("href", "/console/commands/request/shipments.resort");
});

test("command catalog missing access filter includes commands without an app route target", async () => {
  fetchCommandRegistry.mockResolvedValue({
    commands: [
      {
        key: "shipments.print_labels",
        label: "Print labels",
        capability: "shipments.write",
        schema_category: "resource:shipments",
        href: "/commands/request/shipments.print_labels",
        route_targets: {
          portal: { path: "/commands/request/shipments.print_labels" }
        }
      },
      {
        key: "shipments.resort",
        label: "Resort shipment",
        capability: "shipments.write",
        schema_category: "resource:shipments",
        route_targets: {
          console: { path: "/commands/request/shipments.resort" }
        }
      }
    ],
    error: null
  });
  const { createUiServerClient } = jest.requireMock("@masarx/api/server") as {
    createUiServerClient: jest.Mock;
  };
  createUiServerClient.mockReturnValue({
    me: jest.fn().mockResolvedValue({
      capabilities: ["shipments.read", "shipments.write"]
    }),
    readRegistry: jest.fn().mockResolvedValue({
      resources: [
        {
          key: "shipments", relation: "api.shipments",
          label: "Shipments",
          capability_read: "shipments.read"
        }
      ]
    })
  });

  const element = await CommandCatalogPage({
    appKey: "console",
    appLabel: "Console",
    testIdPrefix: "console-commands",
    appBasePath: "/console",
    searchParams: { access: "missing" }
  });

  renderWithIntl(element as React.ReactElement);

  expect(screen.getByText("Print labels")).toBeInTheDocument();
  expect(screen.getByText("No route target")).toBeInTheDocument();
  expect(screen.queryByText("Resort shipment")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Open request" })
  ).not.toBeInTheDocument();
});

test("command catalog allowed filter excludes commands without resource read permission", async () => {
  fetchCommandRegistry.mockResolvedValue({
    commands: [
      {
        key: "shipments.resort",
        label: "Resort shipment",
        capability: "shipments.write",
        schema_category: "resource:shipments",
        route_targets: {
          console: { path: "/commands/request/shipments.resort" }
        }
      },
      {
        key: "shipments.cancel",
        label: "Cancel shipment",
        capability: "shipments.cancel",
        schema_category: "resource:shipments",
        route_targets: {
          console: { path: "/commands/request/shipments.cancel" }
        }
      },
      {
        key: "shipments.print_labels",
        label: "Print labels",
        capability: "shipments.write",
        schema_category: "resource:shipments",
        href: "/commands/request/shipments.print_labels",
        route_targets: {
          portal: { path: "/commands/request/shipments.print_labels" }
        }
      }
    ],
    error: null
  });
  const { createUiServerClient } = jest.requireMock("@masarx/api/server") as {
    createUiServerClient: jest.Mock;
  };
  createUiServerClient.mockReturnValue({
    me: jest.fn().mockResolvedValue({ capabilities: ["shipments.write"] }),
    readRegistry: jest.fn().mockResolvedValue({
      resources: [
        {
          key: "shipments", relation: "api.shipments",
          label: "Shipments",
          capability_read: "shipments.read"
        }
      ]
    })
  });

  const element = await CommandCatalogPage({
    appKey: "console",
    appLabel: "Console",
    testIdPrefix: "console-commands",
    appBasePath: "/console",
    searchParams: { access: "allowed" }
  });

  renderWithIntl(element as React.ReactElement);

  expect(screen.queryByText("Resort shipment")).not.toBeInTheDocument();
  expect(screen.queryByText("Cancel shipment")).not.toBeInTheDocument();
  expect(screen.queryByText("Print labels")).not.toBeInTheDocument();
  expect(
    screen.getByText(
      "No commands are runnable in Console for the current filters. Route-target blocked: 0; command permission blocked: 1; read permission blocked: 2."
    )
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Open request" })
  ).not.toBeInTheDocument();
});

test("command catalog allowed filter reports unavailable read registry readback", async () => {
  fetchCommandRegistry.mockResolvedValue({
    commands: [
      {
        key: "shipments.resort",
        label: "Resort shipment",
        capability: "shipments.write",
        schema_category: "resource:shipments",
        route_targets: {
          console: { path: "/commands/request/shipments.resort" }
        }
      }
    ],
    error: null
  });
  const { createUiServerClient } = jest.requireMock("@masarx/api/server") as {
    createUiServerClient: jest.Mock;
  };
  createUiServerClient.mockReturnValue({
    me: jest.fn().mockResolvedValue({
      capabilities: ["shipments.read", "shipments.write"]
    }),
    readRegistry: jest.fn().mockRejectedValue(new Error("read registry offline"))
  });

  const element = await CommandCatalogPage({
    appKey: "console",
    appLabel: "Console",
    testIdPrefix: "console-commands",
    appBasePath: "/console",
    searchParams: { access: "allowed" }
  });

  renderWithIntl(element as React.ReactElement);

  const status = screen.getByRole("status", {
    name: "Command catalog read registry status"
  });
  expect(status).toHaveAttribute(
    "data-testid",
    "console-commands-read-registry-degraded"
  );
  expect(status.textContent).toBe("Read registry readback is unavailable.");
  expect(status).not.toHaveTextContent("read registry offline");
  expect(
    screen.getByText(
      "No commands can be confirmed runnable in Console because read registry readback is unavailable. Route-target blocked: 0; command permission blocked: 0; readback blocked: 1."
    )
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/read permission blocked: 1/i)
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Open request" })
  ).not.toBeInTheDocument();
});

test("command catalog labels command rows when read registry readback is unavailable", async () => {
  fetchCommandRegistry.mockResolvedValue({
    commands: [
      {
        key: "shipments.resort",
        label: "Resort shipment",
        capability: "shipments.write",
        schema_category: "resource:shipments",
        route_targets: {
          console: { path: "/commands/request/shipments.resort" }
        }
      }
    ],
    error: null
  });
  const { createUiServerClient } = jest.requireMock("@masarx/api/server") as {
    createUiServerClient: jest.Mock;
  };
  createUiServerClient.mockReturnValue({
    me: jest.fn().mockResolvedValue({
      capabilities: ["shipments.read", "shipments.write"]
    }),
    readRegistry: jest.fn().mockRejectedValue(new Error("read registry offline"))
  });

  const element = await CommandCatalogPage({
    appKey: "console",
    appLabel: "Console",
    testIdPrefix: "console-commands",
    appBasePath: "/console"
  });

  renderWithIntl(element as React.ReactElement);

  expect(screen.getByText("Resort shipment")).toBeInTheDocument();
  expect(screen.getByText("Read registry unavailable")).toBeInTheDocument();
  expect(screen.queryByText("Read permission required")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Open request" })
  ).not.toBeInTheDocument();
});

test("command catalog labels commands without an app route target", async () => {
  fetchCommandRegistry.mockResolvedValue({
    commands: [
      {
        key: "shipments.print_labels",
        label: "Print labels",
        capability: "shipments.write",
        workflow_key: "labels_print_workflow_v2",
        binding_key: "shipment_label_workflow",
        stage_key: "print",
        schema_category: "resource:shipments",
        execution: {
          type: "rpc",
          rpc: "ui_execute_command_v1"
        },
        route_targets: {
          portal: { path: "/commands/request/shipments.print_labels" }
        }
      }
    ],
    error: null
  });
  const { createUiServerClient } = jest.requireMock("@masarx/api/server") as {
    createUiServerClient: jest.Mock;
  };
  createUiServerClient.mockReturnValue({
    me: jest.fn().mockResolvedValue({
      capabilities: ["shipments.read", "shipments.write"]
    }),
    readRegistry: jest.fn().mockResolvedValue({
      resources: [
        {
          key: "shipments", relation: "api.shipments",
          label: "Shipments",
          capability_read: "shipments.read"
        }
      ]
    })
  });

  const element = await CommandCatalogPage({
    appKey: "console",
    appLabel: "Console",
    testIdPrefix: "console-commands",
    appBasePath: "/console"
  });

  renderWithIntl(element as React.ReactElement);

  expect(screen.getByText("Print labels")).toBeInTheDocument();
  expect(screen.getByText("No route target")).toBeInTheDocument();
  expect(screen.getByText("Backend reference")).toBeInTheDocument();
  expect(
    screen.getByText(
      "workflow:labels_print_workflow_v2 | binding:shipment_label_workflow/print | rpc:ui_execute_command_v1"
    )
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "This command is registered but has no Console request route, so it cannot be opened from this app."
    )
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Open request" })
  ).not.toBeInTheDocument();
});

test("command catalog searches displayed backend references", async () => {
  fetchCommandRegistry.mockResolvedValue({
    commands: [
      {
        key: "shipments.print_labels",
        label: "Print labels",
        capability: "shipments.write",
        workflow_key: "labels_print_workflow_v2",
        binding_key: "shipment_label_workflow",
        stage_key: "print",
        schema_category: "resource:shipments",
        execution: {
          type: "rpc",
          rpc: "ui_execute_command_v1"
        },
        route_targets: {
          console: { path: "/commands/request/shipments.print_labels" }
        }
      },
      {
        key: "shipments.resort",
        label: "Resort shipment",
        capability: "shipments.write",
        workflow_key: "shipment_resort_workflow_v2",
        schema_category: "resource:shipments",
        route_targets: {
          console: { path: "/commands/request/shipments.resort" }
        }
      }
    ],
    error: null
  });
  const { createUiServerClient } = jest.requireMock("@masarx/api/server") as {
    createUiServerClient: jest.Mock;
  };
  createUiServerClient.mockReturnValue({
    me: jest.fn().mockResolvedValue({
      capabilities: ["shipments.read", "shipments.write"]
    }),
    readRegistry: jest.fn().mockResolvedValue({
      resources: [
        {
          key: "shipments", relation: "api.shipments",
          label: "Shipments",
          capability_read: "shipments.read"
        }
      ]
    })
  });

  const element = await CommandCatalogPage({
    appKey: "console",
    appLabel: "Console",
    testIdPrefix: "console-commands",
    appBasePath: "/console",
    searchParams: { q: "binding:shipment_label_workflow/print" }
  });

  renderWithIntl(element as React.ReactElement);

  expect(screen.getByText("Print labels")).toBeInTheDocument();
  expect(
    screen.getByText(
      "workflow:labels_print_workflow_v2 | binding:shipment_label_workflow/print | rpc:ui_execute_command_v1"
    )
  ).toBeInTheDocument();
  expect(screen.queryByText("Resort shipment")).not.toBeInTheDocument();
  expect(screen.getByText("Showing 1 of 2 commands")).toBeInTheDocument();
});

test.each([undefined, "access_control_policy"])("keeps legitimate non-resource command %s available", async (schema_category) => {
  fetchCommandRegistry.mockResolvedValue({ commands: [{
    key: "policy.request", label: "Request policy", capability: "settings.request",
    schema_category, route_targets: { console: { path: "/settings/request" } },
  }], error: null });
  const { createUiServerClient } = jest.requireMock("@masarx/api/server");
  createUiServerClient.mockReturnValue({
    me: jest.fn().mockResolvedValue({ capabilities: ["settings.request"] }),
    readRegistry: jest.fn().mockResolvedValue({ resources: [{ key: "shipments", relation: "api.shipments", capability_read: "shipments.read" }] }),
  });
  const element = await CommandCatalogPage({ appKey: "console", appLabel: "Console", testIdPrefix: "console-commands", appBasePath: "/console", searchParams: { access: "allowed" } });
  renderWithIntl(element as React.ReactElement);
  expect(screen.getByRole("link", { name: "Open request" })).toHaveAttribute("href", "/console/settings/request");
});
