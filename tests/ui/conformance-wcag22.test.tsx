jest.mock("next/navigation", () => ({
  usePathname: () => "/tracking",
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@masarx/api/server", () => ({ createUiServerClient: jest.fn() }));
jest.mock("../../packages/ui/src/shipment-resource-page", () => ({
  ShipmentResourcePage: () => <div data-testid="shipment-results" />,
}));

import * as fs from "node:fs";
import * as path from "node:path";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createUiServerClient } from "@masarx/api/server";
import { TrackingPage } from "../../packages/ui/src/tracking-page";
import { PrintProgressWidget, type PrintProgressVisualStatus } from "../../packages/ui/src/print-progress-widget";
import { renderWithIntl } from "./test-utils";

// Runtime evidence for the jsdom-checkable WCAG 2.2 AA records (#301 slice 9).
// Each check must match its record in docs/product/ux/wcag22-conformance.json:
// a recorded fail stays tied to its issue, and a fix or a new failure both break this test until the record changes.
const RECORDS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../docs/product/ux/wcag22-conformance.json"), "utf8")
);

function expectRecorded(screenId: string, criterion: string, failures: string[]) {
  const record = RECORDS.screens[screenId].records[criterion];
  expect({ status: failures.length ? "fail" : "pass", failures }).toEqual({
    status: record.status,
    failures: record.status === "fail" ? failures : [],
  });
}

// Auto-running motion: animations and width or transform transitions, unless guarded for reduced motion.
const MOTION = /^(?:animate-(?!none$)\S+|transition-(?:transform|all|\[[^\]]*(?:width|height|transform|inset|left|right|top|bottom)[^\]]*\]))$/;
function unguardedMotion(root: ParentNode) {
  const found = new Set<string>();
  root.querySelectorAll<HTMLElement>("[class]").forEach((el) => {
    const tokens = (el.getAttribute("class") || "").split(/\s+/);
    if (tokens.some((t) => /^motion-reduce:(?:animate-none|transition-none|hidden)$/.test(t))) return;
    tokens.filter((t) => MOTION.test(t)).forEach((t) => found.add(t));
  });
  return [...found].sort();
}

const mockedClient = createUiServerClient as unknown as jest.Mock;
async function renderPortalTracking(trackingNumber?: string) {
  mockedClient.mockReturnValue({
    publicTrackingConfig: jest.fn().mockResolvedValue({
      resource_key: "shipments", filter_key: "tracking_number", param_key: "tracking_number",
    }),
    me: jest.fn().mockResolvedValue(null),
  });
  const node = await TrackingPage({
    appKey: "portal", appBasePath: "/portal", testIdPrefix: "portal-tracking",
    searchParams: trackingNumber ? { tracking_number: trackingNumber } : {},
  });
  return renderWithIntl(node as React.ReactElement);
}

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";
const describeEl = (el: Element | null) =>
  !el ? "none" : `${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}`;

test("portal-tracking keyboard-focus-order", async () => {
  const { container } = await renderPortalTracking("TRK-2026-0001");
  const failures: string[] = [];
  container.querySelectorAll("[tabindex]").forEach((el) => {
    if (Number(el.getAttribute("tabindex")) > 0) failures.push(`positive tabindex on ${describeEl(el)}`);
  });
  if (!screen.queryByRole("searchbox", { name: /\S/ })) failures.push("search field has no accessible name");
  screen.getAllByRole("button").forEach((button) => {
    if (!button.textContent?.trim() && !button.getAttribute("aria-label")) failures.push(`unnamed button ${describeEl(button)}`);
  });
  const expected = [...container.querySelectorAll(FOCUSABLE)];
  const user = userEvent.setup();
  for (const [index, el] of expected.entries()) {
    await user.tab();
    if (document.activeElement !== el) {
      failures.push(`Tab ${index + 1} reached ${describeEl(document.activeElement)}, DOM order expects ${describeEl(el)}`);
      break;
    }
  }
  expectRecorded("portal-tracking", "keyboard-focus-order", failures);
});

test("portal-tracking status-messages", async () => {
  const failures: string[] = [];
  const first = await renderPortalTracking("TRK-2026-0001");
  const readback = screen.queryByTestId("portal-tracking-query-readback");
  if (readback?.getAttribute("role") !== "status") failures.push("query readback is not a status region");
  first.unmount();

  await renderPortalTracking();
  await userEvent.setup().click(screen.getByTestId("portal-tracking-submit"));
  const alert = screen.queryByRole("alert");
  const input = screen.getByTestId("portal-tracking-input");
  if (!alert?.textContent?.trim()) failures.push("empty search shows no alert");
  else if (input.getAttribute("aria-describedby") !== alert.id) failures.push("empty search alert is not linked to the field");
  expectRecorded("portal-tracking", "status-messages", failures);
});

test("portal-tracking reduced-motion", async () => {
  const { container } = await renderPortalTracking("TRK-2026-0001");
  expectRecorded("portal-tracking", "reduced-motion", unguardedMotion(container));
});

test("print-progress-widget reduced-motion", () => {
  const statuses: PrintProgressVisualStatus[] = ["queued", "checking", "generating", "bundling", "downloading"];
  const found = new Set<string>();
  for (const status of statuses) {
    for (const counts of [{}, { freshExpectedCount: 4, freshReadyCount: 1 }]) {
      const view = renderWithIntl(
        <PrintProgressWidget status={status} workflowRunId="run-conformance" selectionCount={4}
          elapsedMs={1200} targetDownloadMs={5000} targetMiss={false} statusSnapshot={counts}
          onExpand={() => undefined} onHide={() => undefined} onDismiss={() => undefined}
          onToggleTechnicalDetails={() => undefined} />
      );
      unguardedMotion(view.container).forEach((token) => found.add(token));
      view.unmount();
    }
  }
  expectRecorded("print-progress-widget", "reduced-motion", [...found].sort());
});
