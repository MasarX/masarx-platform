import type { UiCommandDefinition } from "@masarx/api";
import {
  formatCommandBackendReference,
  resolveCommandReadState,
  resolveCommandHref,
  resolveCommandHrefForRouter,
} from "../../packages/ui/src/command-utils";

type CommandWithHref = UiCommandDefinition & { href?: unknown };

const asCommand = (href?: unknown): CommandWithHref => ({ href });

test("resolveCommandHref prefixes relative hrefs with the app base path", () => {
  expect(resolveCommandHref(asCommand("/settings/request"), "/portal"))
    .toBe("/portal/settings/request");
  expect(resolveCommandHref(asCommand("settings/request"), "/console"))
    .toBe("/console/settings/request");
});

test("resolveCommandHref respects absolute app paths", () => {
  expect(resolveCommandHref(asCommand("/portal/settings/request"), "/portal"))
    .toBe("/portal/settings/request");
});

test("resolveCommandHref returns null for empty or external hrefs", () => {
  expect(resolveCommandHref(asCommand(""), "/portal")).toBeNull();
  expect(resolveCommandHref(asCommand("https://example.com"), "/portal")).toBeNull();
  expect(resolveCommandHref(asCommand(null), "/portal")).toBeNull();
});

test("resolveCommandHref strips unsafe app base path input before prefixing", () => {
  expect(resolveCommandHref(asCommand("settings/request"), "javascript:alert(1)"))
    .toBe("/settings/request");
});

test("resolveCommandHrefForRouter strips safe app base path from resolved href", () => {
  expect(
    resolveCommandHrefForRouter(asCommand("/portal/settings/request"), "/portal")
  ).toBe("/settings/request");
});

test("resolveCommandHrefForRouter keeps unsafe app base paths untouched", () => {
  expect(
    resolveCommandHrefForRouter(
      asCommand("/portal/settings/request"),
      "javascript:alert(1)"
    )
  ).toBe("/settings/request");
});

test("resolveCommandHref requires explicit appKey for route targets", () => {
  const command = {
    route_targets: {
      console: { path: "/settings/request" },
      portal: { path: "/settings/request" },
    },
  } as UiCommandDefinition;
  expect(resolveCommandHref(command, "")).toBeNull();
  expect(resolveCommandHref(command, "", "console")).toBe("/settings/request");
});

test.each(["//example.com/request", "javascript:alert(1)", "mailto:ops@example.com", "/\\\\evil.test/path", `/${String.fromCharCode(9)}evil.test/path`, `/${String.fromCharCode(13)}evil.test/path`])(
  "rejects unsafe legacy and registered command targets: %s",
  (href) => {
    expect(resolveCommandHref(asCommand(href), "/portal")).toBeNull();
    const command = { route_targets: { portal: { path: href } } } as UiCommandDefinition;
    expect(resolveCommandHref(command, "/portal", "portal")).toBeNull();
  },
);

test("explicit app targets never fall through to a legacy href", () => {
  const command = {
    href: "/commands/request/legacy",
    route_targets: { portal: { path: "/commands/request/portal-only" } },
  } as UiCommandDefinition & { href: string };
  expect(resolveCommandHref(command, "/console", "console")).toBeNull();
  expect(resolveCommandHref(command, "/portal", "portal")).toBe("/portal/commands/request/portal-only");
  expect(resolveCommandHref({ ...command, route_targets: {} }, "/console", "console")).toBeNull();
});

test("registered params preserve existing query and fragment", () => {
  const command = { route_targets: { console: {
    path: "/commands/request/test?existing=1#details",
    params: { selected: "A B", omitted: null },
  } } } as UiCommandDefinition;
  expect(resolveCommandHref(command, "/console", "console")).toBe(
    "/console/commands/request/test?existing=1&selected=A+B#details",
  );
  expect(resolveCommandHrefForRouter(command, "/console", "console")).toBe(
    "/commands/request/test?existing=1&selected=A+B#details",
  );
});

test("formats only workflow, binding/stage and RPC backend lineage", () => {
  expect(formatCommandBackendReference({
    workflow_key: "shipment_resort_workflow_v2",
    binding_key: "shipment_resort_binding", stage_key: "resort",
    execution: { type: "rpc", rpc: "ui_execute_shipment_resort_v1" },
  } as UiCommandDefinition)).toBe(
    "workflow:shipment_resort_workflow_v2 | binding:shipment_resort_binding/resort | rpc:ui_execute_shipment_resort_v1",
  );
  expect(formatCommandBackendReference({} as UiCommandDefinition)).toBe("");
});

test("legacy target absence is compatible, but malformed explicit targets fail closed", () => {
  const legacy = { href: "/commands/request/legacy", route_targets: null } as UiCommandDefinition & { href: string };
  expect(resolveCommandHref(legacy, "/console", "console")).toBe("/console/commands/request/legacy");
  for (const route_targets of [[], false, "invalid", { console: null }, { console: { path: "javascript:alert(1)" } }]) {
    expect(resolveCommandHref({ ...legacy, route_targets } as unknown as UiCommandDefinition, "/console", "console")).toBeNull();
  }
});

test("read authority distinguishes resource, unknown and legitimate non-resource commands", () => {
  const registry = { resources: [{ key: "shipments", relation: "api.shipments", capability_read: "shipments.read" }] } as any;
  const caps = new Set(["shipments.read"]);
  const state = (schema_category: string | undefined, value: any = registry, capabilities = caps) =>
    resolveCommandReadState({ schema_category } as UiCommandDefinition, value, capabilities);
  expect(state(undefined, null)).toBe("allowed");
  expect(state("access_control_policy")).toBe("allowed");
  for (const category of ["resource:shipments", "resource/shipments", "resource.shipments", "shipments"]) {
    expect(state(category)).toBe("allowed");
    expect(state(category, registry, new Set())).toBe("denied");
    expect(state(category, null)).toBe("unavailable");
  }
  expect(state("resource:unknown")).toBe("denied");
  expect(state("resource:shipments", { resources: [{ key: "shipments", capability_read: "shipments.read" }] })).toBe("denied");
  expect(state("access_control_policy", null)).toBe("unavailable");
  expect(state("access_control_policy", registry)).toBe("allowed");
});
