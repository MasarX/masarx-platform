jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: () => ({
    reorderResource: jest.fn(),
    updateResource: jest.fn(),
  }),
}));

import { screen } from "@testing-library/react";
import { waitFor } from "@testing-library/react";
import { WorkflowTemplateStudioPage } from "../../packages/ui/src/workflow-template-studio-page";
import { createUiServerClient } from "@masarx/api/server";
import { renderWithIntl } from "./test-utils";

const mockedCreateUiServerClient = createUiServerClient as jest.Mock;

describe("WorkflowTemplateStudioPage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    window.location.hash = "";
  });

  it("renders template and step tables when data resolves", async () => {
    const listResource = jest.fn().mockImplementation((resource: string, _filters: any, limit: number, offset: number) => {
      if (resource === "workflow_template_steps") {
        if (offset === 0) {
          return Promise.resolve({
            resource,
            keys: ["id", "sequence_order", "operation_name"],
            items: [
              { id: "step-1", sequence_order: 1, operation_name: "first_step" },
              { id: "step-2", sequence_order: 2, operation_name: "second_step" },
            ],
            limit,
            offset,
            total: 2,
          });
        }
        return Promise.resolve({
          resource,
          keys: ["id", "sequence_order", "operation_name"],
          items: [],
          limit,
          offset,
          total: 2,
        });
      }
      return Promise.resolve({
        resource,
        keys: ["id"],
        items: [],
        limit,
        offset,
        total: 0,
      });
    });

    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({
        resources: [
          {
            key: "workflow_template_steps",
            reorder: { order_column: "sequence_order", capability: "workflow_runs.write" },
            capability_write: "workflow_runs.write",
            columns: [{ key: "operation_name", label: "Operation" }],
          },
          { key: "workflow_runs", columns: [{ key: "id", label: "Id" }] },
        ],
      }),
      me: jest.fn().mockResolvedValue({
        capabilities: ["workflow_runs.write"],
      }),
      settingsPreview: jest.fn().mockResolvedValue({
        value: {
          paging_mode: "client",
          allowed_sizes: [25, 50],
          default_page_size: 50,
          max_page_size: 50,
        },
      }),
      getResource: jest.fn().mockResolvedValue({
        id: "template-1",
        name: "labels_print_workflow_v1",
      }),
      listResource,
    });

    const node = await WorkflowTemplateStudioPage({
      templateId: "template-1",
      appBasePath: "/console",
      testIdPrefix: "workflow-template-studio",
    });

    renderWithIntl(node);

    expect(
      screen.getByRole("heading", { name: "labels_print_workflow_v1" })
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("workflow-template-studio-ready")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("workflow-template-studio-steps-flow-save")
    ).toBeInTheDocument();
  });

  it("lists webhook sources that resolve to the template via webhook_ingest_policy", async () => {
    window.location.hash = "#workflow-triggers";

    const listResource = jest.fn().mockImplementation((resource: string, _filters: any, limit: number, offset: number) => {
      if (resource === "workflow_template_steps") {
        if (offset === 0) {
          return Promise.resolve({
            resource,
            keys: ["id", "sequence_order", "operation_name"],
            items: [{ id: "step-1", sequence_order: 1, operation_name: "first_step" }],
            limit,
            offset,
            total: 1,
          });
        }
        return Promise.resolve({
          resource,
          keys: ["id", "sequence_order", "operation_name"],
          items: [],
          limit,
          offset,
          total: 1,
        });
      }

      if (resource === "webhook_sources") {
        return Promise.resolve({
          resource,
          keys: ["id"],
          items: [
            {
              id: "00000000-0000-0000-0000-000000000001",
              source_identifier: "source_one",
              name: "Source One",
              provider_type: "shopify",
              enabled: true,
            },
            {
              id: "00000000-0000-0000-0000-000000000002",
              source_identifier: "source_two",
              name: "Source Two",
              provider_type: "shopify",
              enabled: true,
            },
          ],
          limit,
          offset,
          total: 2,
        });
      }

      return Promise.resolve({
        resource,
        keys: ["id"],
        items: [],
        limit,
        offset,
        total: 0,
      });
    });

    const settingsPreview = jest.fn().mockImplementation((params: { category: string; scopeId?: string | null }) => {
      if (params.category === "ui_pagination") {
        return Promise.resolve({ value: null });
      }
      if (params.category === "webhook_ingest_policy") {
        const templateId =
          params.scopeId === "00000000-0000-0000-0000-000000000001"
            ? "template-1"
            : "other-template";
        return Promise.resolve({
          category: "webhook_ingest_policy",
          scope_type: "source",
          scope_id: params.scopeId,
          value: { workflow: { template_id: templateId } },
        });
      }
      return Promise.resolve({ value: null });
    });

    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({
        resources: [
          {
            key: "workflow_template_steps",
            reorder: { order_column: "sequence_order", capability: "workflow_runs.write" },
            capability_write: "workflow_runs.write",
            columns: [{ key: "operation_name", label: "Operation" }],
          },
          { key: "workflow_runs", columns: [{ key: "id", label: "Id" }] },
        ],
      }),
      me: jest.fn().mockResolvedValue({
        capabilities: ["workflow_runs.write", "settings.read", "webhooks.read"],
      }),
      settingsPreview,
      getResource: jest.fn().mockResolvedValue({
        id: "template-1",
        name: "labels_print_workflow_v1",
        steps_checksum: "abc",
      }),
      listResource,
    });

    const node = await WorkflowTemplateStudioPage({
      templateId: "template-1",
      appBasePath: "/console",
      testIdPrefix: "workflow-template-studio",
    });

    renderWithIntl(node);

    await waitFor(() =>
      expect(screen.getByTestId("workflow-template-studio-triggers-ready")).toBeInTheDocument()
    );

    expect(screen.getByText("source_one")).toBeInTheDocument();
    expect(screen.queryByText("source_two")).not.toBeInTheDocument();
  });

  it("renders fallback non-links when appBasePath is unsafe", async () => {
    const listResource = jest.fn().mockImplementation((resource: string, _filters: any, limit: number, offset: number) => {
      if (resource === "workflow_template_steps") {
        if (offset === 0) {
          return Promise.resolve({
            resource,
            keys: ["id", "sequence_order", "operation_name"],
            items: [{ id: "step-1", sequence_order: 1, operation_name: "first_step" }],
            limit,
            offset,
            total: 1,
          });
        }
        return Promise.resolve({
          resource,
          keys: ["id", "sequence_order", "operation_name"],
          items: [],
          limit,
          offset,
          total: 1,
        });
      }
      return Promise.resolve({
        resource,
        keys: ["id"],
        items: [],
        limit,
        offset,
        total: 0,
      });
    });

    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({
        resources: [
          {
            key: "workflow_template_steps",
            reorder: { order_column: "sequence_order", capability: "workflow_runs.write" },
            capability_write: "workflow_runs.write",
            columns: [{ key: "operation_name", label: "Operation" }],
          },
          { key: "workflow_runs", columns: [{ key: "id", label: "Id" }] },
        ],
      }),
      me: jest.fn().mockResolvedValue({
        capabilities: ["workflow_runs.write"],
      }),
      settingsPreview: jest.fn().mockResolvedValue({
        value: {
          paging_mode: "client",
          allowed_sizes: [25, 50],
          default_page_size: 50,
          max_page_size: 50,
        },
      }),
      getResource: jest.fn().mockResolvedValue({
        id: "template-1",
        name: "labels_print_workflow_v1",
      }),
      listResource,
    });

    const node = await WorkflowTemplateStudioPage({
      templateId: "template-1",
      appBasePath: "javascript:alert(1)",
      testIdPrefix: "workflow-template-studio",
    });

    renderWithIntl(node);

    expect(
      screen.queryByRole("link", { name: "Open steps in full view" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open runs in full view" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open webhook sources" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open policy editor" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open source" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit policy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open workflow" })).not.toBeInTheDocument();

    const unsafeLinks = screen
      .queryAllByRole("link")
      .map((link) => (link.getAttribute("href") ?? ""));
    expect(
      unsafeLinks.every((href) => !href.toLowerCase().includes("javascript:"))
    ).toBe(true);
  });

  it("renders error state when template load fails", async () => {
    const listResource = jest.fn().mockImplementation((resource: string, _filters: any, limit: number, offset: number) =>
      Promise.resolve({
        resource,
        keys: ["id"],
        items: [],
        limit,
        offset,
        total: 0,
      })
    );

    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({ resources: [] }),
      me: jest.fn().mockResolvedValue({ capabilities: [] }),
      settingsPreview: jest.fn().mockResolvedValue({ value: null }),
      getResource: jest.fn().mockRejectedValue(new Error("boom")),
      listResource,
    });

    const node = await WorkflowTemplateStudioPage({
      templateId: "missing-template",
      appBasePath: "/console",
      testIdPrefix: "workflow-template-studio",
    });

    renderWithIntl(node);

    expect(screen.getByTestId("workflow-template-studio-error")).toBeInTheDocument();
  });

  it("renders schedule triggers even when webhook triggers are denied", async () => {
    window.location.hash = "#workflow-triggers";

    const listResource = jest.fn().mockImplementation(
      (resource: string, _filters: any, limit: number, offset: number) => {
        if (resource === "workflow_template_steps") {
          if (offset === 0) {
            return Promise.resolve({
              resource,
              keys: ["id", "sequence_order", "operation_name", "handler_key"],
              items: [
                {
                  id: "step-1",
                  sequence_order: 0,
                  operation_name: "reserve_identifiers",
                  handler_key: "reserve_shipment_identifiers",
                },
                {
                  id: "step-2",
                  sequence_order: 1,
                  operation_name: "create_shipment",
                  handler_key: "shipment_create",
                },
              ],
              limit,
              offset,
              total: 2,
            });
          }
          return Promise.resolve({
            resource,
            keys: ["id", "sequence_order", "operation_name", "handler_key"],
            items: [],
            limit,
            offset,
            total: 2,
          });
        }

        if (resource === "workflow_schedule_triggers") {
          return Promise.resolve({
            resource,
            keys: ["id", "enabled", "schedule", "next_run_at"],
            items: [
              {
                id: "schedule-1",
                enabled: true,
                schedule: { type: "interval", interval_seconds: 3600, timezone: "UTC" },
                next_run_at: "2026-01-21T00:00:00Z",
              },
            ],
            limit,
            offset,
            total: 1,
          });
        }

        return Promise.resolve({
          resource,
          keys: ["id"],
          items: [],
          limit,
          offset,
          total: 0,
        });
      }
    );

    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({
        resources: [
          {
            key: "workflow_template_steps",
            reorder: { order_column: "sequence_order", capability: "workflow_runs.write" },
            capability_write: "workflow_runs.write",
            columns: [{ key: "operation_name", label: "Operation" }],
          },
          { key: "workflow_runs", columns: [{ key: "id", label: "Id" }] },
        ],
      }),
      me: jest.fn().mockResolvedValue({
        capabilities: ["workflow_runs.write"],
      }),
      settingsPreview: jest.fn().mockResolvedValue({
        value: {
          paging_mode: "client",
          allowed_sizes: [25, 50],
          default_page_size: 50,
          max_page_size: 50,
        },
      }),
      getResource: jest.fn().mockResolvedValue({
        id: "template-1",
        name: "labels_print_workflow_v1",
        steps_checksum: "abc",
      }),
      listResource,
    });

    const node = await WorkflowTemplateStudioPage({
      templateId: "template-1",
      appBasePath: "/console",
      testIdPrefix: "workflow-template-studio",
    });

    renderWithIntl(node);

    await waitFor(() =>
      expect(
        screen.getByTestId("workflow-template-studio-triggers-ready")
      ).toBeInTheDocument()
    );

    expect(screen.getByText("Schedules")).toBeInTheDocument();
    expect(screen.getByText("Schedules: 1")).toBeInTheDocument();
    expect(screen.getByText("Recurring shipments")).toBeInTheDocument();
    expect(
      screen.getByText("Webhook triggers unavailable. Requires webhooks.read capability.")
    ).toBeInTheDocument();
  });
});
