import type React from "react";
import { render, screen, within } from "@testing-library/react";
import { unwrapMessagesImport } from "@masarx/config";
import { createUiServerClient } from "@masarx/api/server";
import { createServerClient } from "@masarx/auth/server";
import * as arRaw from "../../packages/config/messages/ar.json";
import * as enRaw from "../../packages/config/messages/en.json";
import { WorkflowBindingsPage } from "../../packages/ui/src/workflow-bindings-page";

jest.mock("server-only", () => ({}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("@masarx/api/server", () => ({ createUiServerClient: jest.fn() }));
jest.mock("@masarx/auth/server", () => ({ createServerClient: jest.fn() }));
// createUiTranslator reads the locale from getPublicConfig at render time.
jest.mock("@masarx/config", () => ({
  ...jest.requireActual("@masarx/config"),
  getPublicConfig: () => ({ locale: "ar" }),
}));

type Messages = Record<string, unknown>;
type Area = {
  header: { title: string };
  scope: { title: string };
  bindings: {
    title: string;
    openInStudio: string;
    cloneOverride: string;
    reset: string;
    inherited: string;
    columns: { binding: string };
  };
  inventory: { title: string; stageCounts: string };
};
const area = (raw: unknown) =>
  (unwrapMessagesImport(raw as Messages | { default: Messages }) as { ui: { workflowBindings: Area } }).ui
    .workflowBindings;
const ar = area(arRaw);
const en = area(enRaw);
const ARABIC = /[؀-ۿ]/;

const scopeId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";

describe("WorkflowBindingsPage in Arabic", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (createUiServerClient as jest.Mock).mockReturnValue({
      me: jest.fn().mockResolvedValue({
        capabilities: ["workflow_runs.read", "workflow_runs.write"],
        access_scope: { scope_type: "tenant", scope_id: scopeId, scope_label: "Demo Organization" },
      }),
    });
    (createServerClient as jest.Mock).mockReturnValue({
      rpc: jest.fn().mockResolvedValue({
        data: {
          items: [
            {
              binding_key: "customer_shipment_change",
              binding_label: "Customer shipment change",
              stage_key: "request_received",
              stage_label: "Request received",
              requested_scope_type: "tenant",
              requested_scope_id: scopeId,
              resolved_scope_type: "tenant",
              resolved_scope_id: scopeId,
              workflow_template_id: "template-1",
              workflow_template_name: "Tenant template",
              is_overridden_at_requested_scope: false,
              stage_value: { enabled: true },
            },
          ],
        },
        error: null,
      }),
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          order: jest.fn().mockResolvedValue({
            data: [
              {
                binding_key: "customer_shipment_change",
                label: "Customer shipment change",
                registered_stage_count: 2,
                enabled_stage_count: 1,
              },
            ],
            error: null,
          }),
        })),
      })),
    });
  });

  it("renders headings, columns and actions from the ui.workflowBindings catalog", async () => {
    const node = await WorkflowBindingsPage({
      appKey: "console",
      appBasePath: "/console",
      baseHref: "/console/workflows/bindings",
      testIdPrefix: "console-workflow-bindings",
    });
    render(node as React.ReactElement);

    expect(screen.getByText(ar.header.title)).toBeInTheDocument();
    expect(screen.getByText(ar.scope.title)).toBeInTheDocument();
    expect(screen.getByText(ar.bindings.title)).toBeInTheDocument();
    expect(screen.getByText(ar.inventory.title)).toBeInTheDocument();

    const table = screen.getByTestId("console-workflow-bindings-bindings-table");
    expect(within(table).getByText(ar.bindings.columns.binding)).toBeInTheDocument();
    expect(within(table).getByText(ar.bindings.inherited)).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: ar.bindings.openInStudio })).toBeInTheDocument();
    expect(within(table).getByRole("button", { name: ar.bindings.cloneOverride })).toBeInTheDocument();
    expect(within(table).getByRole("button", { name: ar.bindings.reset })).toBeInTheDocument();

    expect(screen.getByTestId("console-workflow-bindings-inventory")).toHaveTextContent(
      ar.inventory.stageCounts.replace("{total}", "2").replace("{enabled}", "1"),
    );
  });

  it("keeps the English values equal to the former literals and gives Arabic values", () => {
    expect(en.header.title).toBe("Workflow bindings");
    expect(en.bindings.cloneOverride).toBe("Clone override");
    expect(en.inventory.stageCounts).toBe("{total} total / {enabled} enabled");
    for (const value of [ar.header.title, ar.bindings.cloneOverride, ar.inventory.stageCounts]) {
      expect(value).toMatch(ARABIC);
    }
  });
});
