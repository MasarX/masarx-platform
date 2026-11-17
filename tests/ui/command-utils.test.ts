import type { UiCommandDefinition } from "@masarx/api";
import {
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
