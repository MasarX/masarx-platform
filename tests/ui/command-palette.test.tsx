import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "../../packages/ui/src/command-palette";
import { setUiReporter } from "../../packages/ui/src/reporting";

const push = jest.fn();
const mockUseCommandRegistry = jest.fn();
const mockUseReadRegistry = jest.fn();
const commandRegistryResult = {
  data: [
    {
      key: "shipments.create",
      label: "Create shipment",
      description: "Create a new shipment.",
      capability: "shipments.write",
      schema_category: "resource:shipments",
      selection: { mode: "none" },
      route_targets: {
        console: { path: "/console/commands/shipments.create" },
      },
    },
  ],
  error: null,
  isLoading: false,
};

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

jest.mock("../../packages/ui/src/command-registry-client", () => ({
  useCommandRegistry: () => mockUseCommandRegistry(),
}));

jest.mock("../../packages/ui/src/read-registry-client", () => ({
  useReadRegistry: () => mockUseReadRegistry(),
}));

const navigationSections = [
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
];

test("command palette normalizes raw access codes even without NavigationNext", async () => {
  const user = userEvent.setup();
  const onRecordRecent = jest.fn();
  render(<CommandPalette open onOpenChange={() => {}} appKey="console"
    navigationSections={[{ id: "ops", label: "Operations", items: [{
      id: "denied", label: "Denied shipment", href: "/denied", disabled_reason: "missing_capability",
    }] }]} favorites={[]} recents={[]} onRecordRecent={onRecordRecent} />);
  const item = await screen.findByRole("button", {
    name: /Denied shipment.*You do not have access to this page\./,
  });
  expect(item).toBeDisabled();
  expect(screen.queryByText("missing_capability")).toBeNull();
  await user.type(screen.getByTestId("console-command-palette-search"), "Denied shipment");
  await user.keyboard("{Enter}");
  expect(push).not.toHaveBeenCalled();
  expect(onRecordRecent).not.toHaveBeenCalled();
});

afterEach(() => {
  setUiReporter(null);
  push.mockClear();
  mockUseCommandRegistry.mockReset();
  mockUseReadRegistry.mockReset();
});

beforeEach(() => {
  mockUseCommandRegistry.mockReturnValue(commandRegistryResult);
  mockUseReadRegistry.mockReturnValue({
    data: {
      resources: [
        {
          key: "shipments", relation: "api.shipments",
          label: "Shipments",
          capability_read: "shipments.read",
        },
      ],
    },
    error: null,
    isLoading: false,
  });
});

test("command palette emits open telemetry", async () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  render(
    <CommandPalette
      open
      onOpenChange={() => {}}
      appKey="console"
      appBasePath="/console"
      navigationSections={navigationSections}
      favorites={[]}
      recents={[]}
      onRecordRecent={() => {}}
    />
  );

  await waitFor(() =>
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ui.command_palette.open", context: "console" })
    )
  );
});

test("command palette emits execute telemetry for navigation items", async () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  const user = userEvent.setup();
  render(
    <CommandPalette
      open
      onOpenChange={() => {}}
      appKey="console"
      appBasePath="/console"
      navigationSections={navigationSections}
      favorites={[]}
      recents={[]}
      onRecordRecent={() => {}}
    />
  );

  await waitFor(() =>
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ui.command_palette.open" })
    )
  );
  reporter.mockClear();

  const item = await screen.findByRole("button", { name: /Shipments/ });
  await user.click(item);

  expect(reporter).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "ui.command_palette.execute",
      context: "navigation",
    })
  );
  expect(push).toHaveBeenCalledWith("/resources/shipments");
});

test("command palette keeps raw navigation href when appBasePath is unsafe", async () => {
  const reporter = jest.fn();
  const user = userEvent.setup();
  setUiReporter(reporter);
  render(
    <CommandPalette
      open
      onOpenChange={() => {}}
      appKey="console"
      appBasePath="javascript:alert(1)"
      navigationSections={navigationSections}
      favorites={[]}
      recents={[]}
      onRecordRecent={() => {}}
    />
  );

  await waitFor(() =>
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ui.command_palette.open" })
    )
  );
  reporter.mockClear();

  const item = await screen.findByRole("button", { name: /Shipments/ });
  await user.click(item);

  expect(push).toHaveBeenCalledWith("/console/resources/shipments");
});

test("command palette disables unsafe navigation hrefs from the registry", async () => {
  render(
    <CommandPalette
      open
      onOpenChange={() => {}}
      appKey="console"
      appBasePath="/console"
      navigationSections={[
        {
          id: "ops",
          label: "Operations",
          items: [
            {
              id: "unsafe",
              label: "Unsafe target",
              href: "javascript:alert(1)",
            },
          ],
        },
      ]}
      favorites={[]}
      recents={[]}
      onRecordRecent={() => {}}
    />
  );

  const item = await screen.findByRole("button", { name: /Unsafe target/ });
  expect(item).toBeDisabled();
  expect(item).toHaveTextContent("No route target available.");

  fireEvent.click(item);

  expect(push).not.toHaveBeenCalled();
});

test("command palette emits execute telemetry for commands", async () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  const user = userEvent.setup();
  render(
    <CommandPalette
      open
      onOpenChange={() => {}}
      appKey="console"
      appBasePath="/console"
      navigationSections={navigationSections}
      favorites={[]}
      recents={[]}
      onRecordRecent={() => {}}
      capabilities={["shipments.read", "shipments.write"]}
    />
  );

  await waitFor(() =>
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ui.command_palette.open" })
    )
  );
  reporter.mockClear();

  const item = await screen.findByRole("button", { name: /Create shipment/ });
  await user.click(item);

  expect(reporter).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "ui.command_palette.execute",
      context: "command",
    })
  );
  expect(push).toHaveBeenCalledWith("/commands/shipments.create");
});

test("command palette disables resource commands without read permission", async () => {
  mockUseCommandRegistry.mockReturnValue({
    data: [
      {
        key: "shipments.create",
        label: "Create shipment",
        description: "Create a new shipment.",
        capability: "shipments.write",
        schema_category: "resource:shipments",
        selection: { mode: "none" },
        route_targets: {
          console: { path: "/console/commands/shipments.create" },
        },
      },
    ],
    error: null,
    isLoading: false,
  });

  render(
    <CommandPalette
      open
      onOpenChange={() => {}}
      appKey="console"
      appBasePath="/console"
      navigationSections={navigationSections}
      favorites={[]}
      recents={[]}
      onRecordRecent={() => {}}
      capabilities={["shipments.write"]}
    />
  );

  const item = await screen.findByRole("button", { name: /Create shipment/ });
  expect(item).toBeDisabled();
  expect(item).toHaveTextContent("Read permission required.");

  fireEvent.click(item);

  expect(push).not.toHaveBeenCalled();
});

test("command palette keeps all-blocked search results visible with status readback", async () => {
  const user = userEvent.setup();
  render(
    <CommandPalette
      open
      onOpenChange={() => {}}
      appKey="console"
      appBasePath="/console"
      navigationSections={navigationSections}
      favorites={[]}
      recents={[]}
      onRecordRecent={() => {}}
      capabilities={["shipments.write"]}
    />
  );

  const input = await screen.findByLabelText("Search command palette");
  await user.type(input, "create");

  const status = await screen.findByTestId(
    "console-command-palette-blocked-results"
  );
  expect(status).toHaveAttribute("aria-live", "polite");
  expect(status).toHaveTextContent("Read permission required.");

  const item = await screen.findByRole("button", { name: /Create shipment/ });
  expect(item).toBeDisabled();
  expect(screen.queryByText("No matches")).not.toBeInTheDocument();
});

test("command palette reports read registry failure and disables resource commands", async () => {
  mockUseCommandRegistry.mockReturnValue({
    data: [
      {
        key: "shipments.create",
        label: "Create shipment",
        description: "Create a new shipment.",
        capability: "shipments.write",
        schema_category: "resource:shipments",
        selection: { mode: "none" },
        route_targets: {
          console: { path: "/console/commands/shipments.create" },
        },
      },
    ],
    error: null,
    isLoading: false,
  });
  mockUseReadRegistry.mockReturnValue({
    data: undefined,
    error: new Error("read registry offline"),
    isLoading: false,
  });

  render(
    <CommandPalette
      open
      onOpenChange={() => {}}
      appKey="console"
      appBasePath="/console"
      navigationSections={navigationSections}
      favorites={[]}
      recents={[]}
      onRecordRecent={() => {}}
      capabilities={["shipments.read", "shipments.write"]}
    />
  );

  const status = await screen.findByTestId(
    "console-command-palette-read-registry-error"
  );
  expect(status).toHaveAttribute("aria-live", "polite");
  expect(status).toHaveTextContent("Read registry unavailable");
  expect(status.textContent?.trim()).toBe("Read registry unavailable.");
  expect(status).not.toHaveTextContent("offline");

  const item = await screen.findByRole("button", { name: /Create shipment/ });
  expect(item).toBeDisabled();
  expect(item).toHaveTextContent("Read registry unavailable.");
});

test("command palette reports registry readback failure without hiding navigation", async () => {
  mockUseCommandRegistry.mockReturnValue({
    data: undefined,
    error: new Error("registry offline"),
    isLoading: false,
  });
  render(
    <CommandPalette
      open
      onOpenChange={() => {}}
      appKey="console"
      appBasePath="/console"
      navigationSections={navigationSections}
      favorites={[]}
      recents={[]}
      onRecordRecent={() => {}}
    />
  );

  const status = await screen.findByTestId(
    "console-command-palette-registry-error"
  );
  expect(status).toHaveAttribute("aria-live", "polite");
  expect(status).toHaveTextContent("Command registry unavailable");
  expect(status.textContent?.trim()).toBe("Command registry unavailable");
  expect(status).not.toHaveTextContent("offline");
  expect(screen.getByRole("button", { name: /Shipments/ })).toBeInTheDocument();
  expect(screen.queryByText("No matches")).not.toBeInTheDocument();
});

test("command palette announces blocked searched result readback", async () => {
  const user = userEvent.setup();
  mockUseCommandRegistry.mockReturnValue({
    data: [
      {
        key: "shipments.create",
        label: "Create shipment",
        description: "Create a new shipment.",
        capability: "shipments.write",
        selection: { mode: "none" },
        route_targets: {
          console: { path: "/console/commands/shipments.create" },
        },
      },
    ],
    error: null,
    isLoading: false,
  });

  render(
    <CommandPalette
      open
      onOpenChange={() => {}}
      appKey="console"
      appBasePath="/console"
      navigationSections={navigationSections}
      favorites={[]}
      recents={[]}
      onRecordRecent={() => {}}
      capabilities={[]}
    />
  );

  const input = await screen.findByLabelText("Search command palette");
  await user.type(input, "create");

  const readback = await screen.findByTestId(
    "console-command-palette-active-readback"
  );
  expect(readback).toHaveAttribute("aria-live", "polite");
  expect(readback).toHaveTextContent("Create shipment");
  expect(readback).toHaveTextContent("Command");
  expect(readback).toHaveTextContent("Missing required capability");
  const blockedItem = screen.getByRole("button", { name: /Create shipment/ });
  await waitFor(() => expect(blockedItem).toHaveAttribute("aria-selected", "false"));
  expect(blockedItem).toBeDisabled();
  expect(screen.getByTestId("console-command-palette-active-readback")).toHaveTextContent("Create shipment");
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.click(blockedItem);
  expect(push).not.toHaveBeenCalled();

});

test("command palette searches and announces command backend references", async () => {
  const user = userEvent.setup();
  mockUseCommandRegistry.mockReturnValue({
    data: [
      {
        key: "shipments.resort",
        label: "Resort shipment",
        description: "Resort a shipment after address correction.",
        capability: "shipments.write",
        schema_category: "resource:shipments",
        workflow_key: "shipment_resort_workflow_v2",
        binding_key: "shipment_resort_binding",
        stage_key: "resort",
        execution: {
          type: "rpc",
          rpc: "ui_execute_shipment_resort_v1",
        },
        selection: { mode: "none" },
        route_targets: {
          console: { path: "/console/commands/shipments.resort" },
        },
      },
    ],
    error: null,
    isLoading: false,
  });

  render(
    <CommandPalette
      open
      onOpenChange={() => {}}
      appKey="console"
      appBasePath="/console"
      navigationSections={navigationSections}
      favorites={[]}
      recents={[]}
      onRecordRecent={() => {}}
      capabilities={["shipments.read", "shipments.write"]}
    />
  );

  const input = await screen.findByLabelText("Search command palette");
  expect(input).toHaveAttribute(
    "placeholder",
    "Search pages, workflows, commands, and backend references"
  );
  await user.type(input, "ui_execute_shipment_resort_v1");

  const item = await screen.findByRole("button", { name: /Resort shipment/ });
  expect(item).toHaveTextContent(
    "Backend reference: workflow:shipment_resort_workflow_v2 | binding:shipment_resort_binding/resort | rpc:ui_execute_shipment_resort_v1"
  );

  const readback = await screen.findByTestId(
    "console-command-palette-active-readback"
  );
  expect(readback).toHaveTextContent("Resort shipment");
  expect(readback).toHaveTextContent(
    "Backend reference: workflow:shipment_resort_workflow_v2 | binding:shipment_resort_binding/resort | rpc:ui_execute_shipment_resort_v1"
  );
});

test("command palette announces registry readback loading state", async () => {
  mockUseCommandRegistry.mockReturnValue({
    data: undefined,
    error: null,
    isLoading: true,
  });
  render(
    <CommandPalette
      open
      onOpenChange={() => {}}
      appKey="console"
      appBasePath="/console"
      navigationSections={navigationSections}
      favorites={[]}
      recents={[]}
      onRecordRecent={() => {}}
    />
  );

  const status = await screen.findByTestId(
    "console-command-palette-loading"
  );
  expect(status).toHaveAttribute("aria-live", "polite");
  expect(status).toHaveTextContent("Loading command registry...");
});

test("command palette closes on escape", async () => {
  const user = userEvent.setup();
  const onOpenChange = jest.fn();
  render(
    <CommandPalette
      open
      onOpenChange={onOpenChange}
      appKey="console"
      appBasePath="/console"
      navigationSections={navigationSections}
      favorites={[]}
      recents={[]}
      onRecordRecent={() => {}}
    />
  );

  const input = await screen.findByLabelText("Search command palette");
  await waitFor(() => expect(input).toHaveFocus());

  await user.type(input, "ship");
  expect(input).toHaveValue("ship");

  fireEvent.keyDown(input, { key: "Escape", code: "Escape", keyCode: 27, which: 27 });

  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(input).toHaveValue("");
});

test("unavailable bare category recovers without hiding the command", async () => {
  mockUseCommandRegistry.mockReturnValue({ data: [{
    key: "policy.request", label: "Request policy", capability: "settings.request",
    schema_category: "access_control_policy",
    route_targets: { console: { path: "/settings/request" } },
  }], error: null, isLoading: false });
  mockUseReadRegistry.mockReturnValue({ data: undefined, error: new Error("offline"), isLoading: false });
  const props = { open: true, onOpenChange: jest.fn(), appKey: "console", appBasePath: "/console",
    navigationSections, favorites: [], recents: [], onRecordRecent: jest.fn(), capabilities: ["settings.request"] };
  const view = render(<CommandPalette {...props} />);
  expect(await screen.findByRole("button", { name: /Request policy/ })).toBeDisabled();
  mockUseReadRegistry.mockReturnValue({ data: { resources: [{ key: "shipments", relation: "api.shipments", capability_read: "shipments.read" }] }, error: null, isLoading: false });
  view.rerender(<CommandPalette {...props} />);
  expect(await screen.findByRole("button", { name: /Request policy/ })).toBeEnabled();
});

test("unsafe favorites and recents cannot execute by click or keyboard", async () => {
  render(<CommandPalette open onOpenChange={jest.fn()} appKey="console" appBasePath="/console"
    navigationSections={[{ id: "unsafe", label: "Unsafe", items: [{ id: "bad", label: "Unsafe target", href: "javascript:alert(1)" }] }]}
    favorites={["bad"]} recents={["bad"]} onRecordRecent={jest.fn()} />);
  for (const item of screen.getAllByRole("button", { name: /Unsafe target/ })) {
    expect(item).toBeDisabled();
    fireEvent.click(item);
  }
  fireEvent.keyDown(screen.getByLabelText("Search command palette"), { key: "Enter" });
  expect(push).not.toHaveBeenCalled();
});

test("Arabic command palette localizes registry labels and capability reason", () => {
  const originalLocale = process.env.NEXT_PUBLIC_LOCALE;
  process.env.NEXT_PUBLIC_LOCALE = "ar";
  try {
    mockUseCommandRegistry.mockReturnValue({ data: [
      { key: "shipments.delete", label: "Delete shipments", label_ar: "حذف الشحنات", route_targets: { console: { path: "/console/commands/shipments.delete" } } },
      { key: "shipments.create", label: "Create shipment", route_targets: { console: { path: "/console/commands/shipments.create" } } },
    ], error: null, isLoading: false });
    const view = render(<CommandPalette open onOpenChange={jest.fn()} appKey="console" appBasePath="/console"
      navigationSections={[{ id: "ops", label: "Operations", items: [{ id: "blocked", label: "Blocked", href: "/console/blocked", capability: "blocked.read", disabled_reason: "missing_capability" }] }]}
      favorites={[]} recents={[]} onRecordRecent={jest.fn()} />);
    expect(screen.getByText("حذف الشحنات")).toBeInTheDocument();
    expect(screen.getByText("Create shipment")).toBeInTheDocument();
    expect(screen.getByText("ليست لديك صلاحية الوصول إلى هذه الصفحة.")).toBeInTheDocument();
    view.unmount();
  } finally {
    if (originalLocale === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
    else process.env.NEXT_PUBLIC_LOCALE = originalLocale;
  }
});
