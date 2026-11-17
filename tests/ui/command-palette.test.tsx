import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "../../packages/ui/src/command-palette";
import { setUiReporter } from "../../packages/ui/src/reporting";

const push = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

jest.mock("../../packages/ui/src/command-registry-client", () => ({
  useCommandRegistry: () => ({
    data: [
      {
        key: "shipments.create",
        label: "Create shipment",
        description: "Create a new shipment.",
        selection: { mode: "none" },
        route_targets: {
          console: { path: "/console/commands/shipments.create" },
        },
      },
    ],
    isLoading: false,
  }),
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

afterEach(() => {
  setUiReporter(null);
  push.mockClear();
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
      capabilities={["shipments.write"]}
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
