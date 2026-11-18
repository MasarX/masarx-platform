import React from "react";
import { screen } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import en from "../../packages/config/messages/en.json";
import ar from "../../packages/config/messages/ar.json";
import { InvestigationLinks } from "../../apps/console/app/_components/investigation-links";
import { ResourcePage } from "../../apps/console/app/_components/resource-page";

const me = jest.fn();
let locale = "en";
jest.mock("@masarx/api/server", () => ({ createUiServerClient: () => ({ me }) }));
jest.mock("next-intl/server", () => ({ getTranslations: async () =>
  (key: "trace" | "policy", { id }: { id: string }) =>
    (locale === "ar" ? ar : en).ui.investigation[key].replace("{id}", id),
}));
const context: { detail: Record<string, unknown> | null; detailError: string | null } = {
  detail: null, detailError: null,
};
jest.mock("@masarx/ui", () => ({
  LoadingState: () => null,
  hasCapability: jest.requireActual("../../packages/ui/src/capabilities").hasCapability,
  resolveCapabilitySet: jest.requireActual("../../packages/ui/src/capabilities").resolveCapabilitySet,
  ResourcePage: ({ renderDetailFooter }: { renderDetailFooter?: (value: typeof context) => React.ReactNode }) =>
    <div>{renderDetailFooter?.(context)}</div>,
}));
beforeEach(() => {
  locale = "en";
  me.mockReset().mockResolvedValue({ capabilities: ["audit_log.read", "settings.read"] });
  context.detail = { correlation_id: "correlation/with space", settings_resolution_id: "resolution-1" };
  context.detailError = null;
});
test.each(["audit_table_changes", "decision_log"])("%s links authorized investigation context using the console base path", async () => {
  renderWithIntl(await InvestigationLinks({ detail: context.detail!, appBasePath: "/console" }));
  expect(screen.getByRole("link", { name: "Activity: correlation/with space" })).toHaveAttribute(
    "href", "/console/observability/trace/correlation%2Fwith%20space");
  expect(screen.getByRole("link", { name: "Policy resolution: resolution-1" })).toHaveAttribute(
    "href", "/console/resources/settings_resolution_log?id=resolution-1&detail_open=1");
});
test.each(["missing", "denied", "unrelated"])("does not render investigation links for %s detail", (state) => {
  if (state === "missing") context.detail = null;
  if (state === "denied") context.detailError = "Permission denied";
  renderWithIntl(<ResourcePage appKey="console" appBasePath="/console"
    resourceKey={state === "unrelated" ? "users" : "audit_table_changes"} searchParams={{}} />);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
test("preserves an existing resource footer", () => {
  renderWithIntl(<ResourcePage appKey="console" appBasePath="/console" resourceKey="decision_log"
    searchParams={{}} renderDetailFooter={() => <p>Existing action</p>} />);
  expect(screen.getByText("Existing action")).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});


test("renders real Arabic investigation labels", async () => {
  locale = "ar";
  renderWithIntl(await InvestigationLinks({ detail: context.detail!, appBasePath: "/console" }));
  const arabicActivity = String.fromCodePoint(0x627,0x644,0x646,0x634,0x627,0x637);
  expect(screen.getByRole("link", { name: `${arabicActivity}: correlation/with space` })).toBeInTheDocument();
  expect(ar.ui.investigation.trace).not.toContain("?");
  expect(ar.ui.investigation.policy).not.toContain("?");
});
test.each([[], ["audit_log.read"], ["settings.read"]])("links only accessible destinations for %j", async (...caps) => {
  me.mockResolvedValue({ capabilities: caps });
  renderWithIntl(await InvestigationLinks({ detail: context.detail!, appBasePath: "/console" }));
  expect(screen.queryByText("Activity: correlation/with space") !== null).toBe(caps.includes("audit_log.read"));
  expect(screen.queryByText("Policy resolution: resolution-1") !== null).toBe(caps.includes("settings.read"));
});
test("hides investigation links if current capabilities cannot be loaded", async () => {
  me.mockRejectedValue(new Error("Permission denied"));
  renderWithIntl(await InvestigationLinks({ detail: context.detail!, appBasePath: "/console" }));
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
