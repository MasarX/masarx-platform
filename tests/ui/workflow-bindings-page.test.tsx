import type React from "react";
import { render, screen, within } from "@testing-library/react";
import { createUiServerClient } from "@masarx/api/server";
import { createServerClient } from "@masarx/auth/server";
import { WorkflowBindingsPage } from "../../packages/ui/src/workflow-bindings-page";

jest.mock("server-only", () => ({}));

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    ...props
  }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

jest.mock("@masarx/auth/server", () => ({
  createServerClient: jest.fn(),
}));

const mockedCreateUiServerClient = createUiServerClient as jest.Mock;
const mockedCreateServerClient = createServerClient as jest.Mock;

type MockBindingItem = Record<string, unknown>;
type MockInventoryItem = Record<string, unknown>;

function mockWorkflowBindingsPageData(params?: {
  capabilities?: string[];
  scopeType?: string;
  scopeId?: string;
  scopeLabel?: string;
  bindingItems?: MockBindingItem[];
  inventoryItems?: MockInventoryItem[];
}) {
  const scopeType = params?.scopeType ?? "tenant";
  const scopeId = params?.scopeId ?? "99999999-aaaa-4bbb-8ccc-dddddddddddd";
  const scopeLabel = params?.scopeLabel ?? "Demo Organization";

  mockedCreateUiServerClient.mockReturnValue({
    me: jest.fn().mockResolvedValue({
      capabilities: params?.capabilities ?? ["workflow_runs.read", "workflow_runs.write"],
      access_scope: {
        scope_type: scopeType,
        scope_id: scopeId,
        scope_label: scopeLabel,
      },
    }),
  });

  mockedCreateServerClient.mockReturnValue({
    rpc: jest.fn().mockResolvedValue({
      data: {
        items: params?.bindingItems ?? [],
      },
      error: null,
    }),
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        order: jest.fn().mockResolvedValue({
          data: params?.inventoryItems ?? [],
          error: null,
        }),
      })),
    })),
  });

  return { scopeType, scopeId, scopeLabel };
}

async function renderWorkflowBindingsPage(searchParams: Record<string, string> = {}) {
  const result = await WorkflowBindingsPage({
    appKey: "console",
    appBasePath: "/console",
    baseHref: "/console/workflows/bindings",
    testIdPrefix: "console-workflow-bindings",
    searchParams,
  });

  render(result as React.ReactElement);
}

function expectHiddenInputValue(form: Element | null, name: string, value: string) {
  expect(form).not.toBeNull();
  const input = form?.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
  expect(input).not.toBeNull();
  expect(input?.value).toBe(value);
}

describe("WorkflowBindingsPage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("renders friendly scope labels and keeps scope ids secondary", async () => {
    const tenantScopeId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
    mockWorkflowBindingsPageData({
      scopeId: tenantScopeId,
      bindingItems: [
        {
          binding_key: "customer_shipment_change",
          binding_label: "Customer shipment change",
          stage_key: "request_received",
          stage_label: "Request received",
          requested_scope_type: "tenant",
          requested_scope_id: tenantScopeId,
          resolved_scope_type: "tenant",
          resolved_scope_id: tenantScopeId,
          workflow_template_id: "template-1",
          workflow_template_name: "Tenant template",
          is_overridden_at_requested_scope: false,
          stage_value: { enabled: true },
        },
      ],
      inventoryItems: [
        {
          binding_key: "customer_shipment_change",
          label: "Customer shipment change",
          current_execution_kind: "workflow_native",
          configurability_status: "workflow_configurable",
          entrypoint_type: "api",
          actor_surface: "console",
          registered_stage_count: 2,
          enabled_stage_count: 2,
          owner: "ops",
          migration_phase: "phase-1",
        },
      ],
    });

    await renderWorkflowBindingsPage();

    expect(screen.getByTestId("console-workflow-bindings-scope-summary")).toHaveTextContent(
      "Organization: Demo Organization",
    );
    expect(screen.getByTestId("console-workflow-bindings-scope-summary")).not.toHaveTextContent(
      tenantScopeId,
    );
    expect(screen.getByTestId("console-workflow-bindings-scope-reference")).toHaveTextContent(
      "REF-9999DDDD",
    );

    const bindingsTable = screen.getByTestId("console-workflow-bindings-bindings-table");
    expect(bindingsTable).toHaveTextContent("Organization: Demo Organization");
    expect(bindingsTable).toHaveTextContent("Requested: Organization: Demo Organization");
    expect(bindingsTable).not.toHaveTextContent(tenantScopeId);

    const firstLink = within(bindingsTable).getByRole("link", { name: "Open in studio" });
    expect(firstLink).toHaveAttribute("href", "/console/workflows/templates/template-1");
  });

  it("keeps clone and reset mutations bound to the requested scope even when the resolved binding is inherited", async () => {
    const bindingKey = "customer_shipment_change";
    const stageKey = "request_received";
    const workflowTemplateId = "template-global";
    const tenantScopeId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
    mockWorkflowBindingsPageData({
      scopeId: tenantScopeId,
      bindingItems: [
        {
          binding_key: bindingKey,
          binding_label: "Customer shipment change",
          stage_key: stageKey,
          stage_label: "Request received",
          requested_scope_type: "tenant",
          requested_scope_id: tenantScopeId,
          resolved_scope_type: "global",
          resolved_scope_id: null,
          workflow_template_id: workflowTemplateId,
          workflow_template_name: "Global template",
          is_overridden_at_requested_scope: false,
          stage_value: { enabled: true },
        },
      ],
      inventoryItems: [],
    });

    await renderWorkflowBindingsPage();

    const bindingsTable = screen.getByTestId("console-workflow-bindings-bindings-table");
    const row = within(bindingsTable)
      .getByText("Customer shipment change")
      .closest("tr");

    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("Requested: Organization: Demo Organization");
    expect(row).not.toHaveTextContent(tenantScopeId);

    const cloneButton = within(row as HTMLElement).getByRole("button", { name: "Clone override" });
    const resetButton = within(row as HTMLElement).getByRole("button", { name: "Reset" });

    const cloneForm = cloneButton.closest("form");
    expectHiddenInputValue(cloneForm, "binding_key", bindingKey);
    expectHiddenInputValue(cloneForm, "stage_key", stageKey);
    expectHiddenInputValue(cloneForm, "scope_type", "tenant");
    expectHiddenInputValue(cloneForm, "scope_id", tenantScopeId);

    const resetForm = resetButton.closest("form");
    expectHiddenInputValue(resetForm, "binding_key", bindingKey);
    expectHiddenInputValue(resetForm, "stage_key", stageKey);
    expectHiddenInputValue(resetForm, "scope_type", "tenant");
    expectHiddenInputValue(resetForm, "scope_id", tenantScopeId);

    const openInStudio = within(row as HTMLElement).getByRole("link", { name: "Open in studio" });
    expect(openInStudio).toHaveAttribute(
      "href",
      `/console/workflows/templates/${workflowTemplateId}`,
    );
  });
});
