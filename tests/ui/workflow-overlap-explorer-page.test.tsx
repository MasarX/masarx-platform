jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

import { screen } from "@testing-library/react";
import { WorkflowOverlapExplorerPage } from "../../packages/ui/src/workflow-overlap-explorer-page";
import { createUiServerClient } from "@masarx/api/server";
import { renderWithIntl } from "./test-utils";

const mockedCreateUiServerClient = createUiServerClient as jest.Mock;

describe("WorkflowOverlapExplorerPage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("renders overlap groups when duplicate workflow definitions exist", async () => {
    const listResource = jest.fn().mockImplementation((resource: string) => {
      if (resource === "workflow_templates") {
        return Promise.resolve({
          resource,
          keys: ["id"],
          items: [
            {
              id: "tmpl-1",
              name: "workflow_one",
              steps_checksum: "abc123abc123abc123",
              status: "active",
              scope_type: "global",
              scope_id: "-",
              updated_at: "2026-01-20T00:00:00Z",
            },
            {
              id: "tmpl-2",
              name: "workflow_two",
              steps_checksum: "abc123abc123abc123",
              status: "active",
              scope_type: "global",
              scope_id: "-",
              updated_at: "2026-01-20T00:00:00Z",
            },
            {
              id: "tmpl-3",
              name: "workflow_unique",
              steps_checksum: "def456def456def456",
              status: "active",
              scope_type: "global",
              scope_id: "-",
              updated_at: "2026-01-20T00:00:00Z",
            },
          ],
          limit: 200,
          offset: 0,
          total: 3,
        });
      }
      return Promise.resolve({
        resource,
        keys: ["id"],
        items: [],
        limit: 25,
        offset: 0,
        total: 0,
      });
    });

    mockedCreateUiServerClient.mockReturnValue({
      settingsPreview: jest.fn().mockResolvedValue({ value: null }),
      listResource,
    });

    const node = await WorkflowOverlapExplorerPage({
      appBasePath: "/console",
      searchParams: {},
      testIdPrefix: "workflow-overlap-explorer",
    });

    renderWithIntl(node);

    expect(
      screen.getByTestId("workflow-overlap-explorer-ready")
    ).toBeInTheDocument();

    expect(screen.getByText("workflow_one")).toBeInTheDocument();
    expect(screen.getByText("workflow_two")).toBeInTheDocument();
  });

  it("hides unsafe base-path links when appBasePath is unsafe", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      settingsPreview: jest.fn().mockResolvedValue({ value: null }),
      listResource: jest.fn().mockResolvedValue({
        resource: "workflow_templates",
        keys: ["id"],
        items: [
          {
            id: "tmpl-1",
            name: "workflow_one",
            steps_checksum: "abc123abc123abc123",
            status: "active",
            scope_type: "global",
            scope_id: "-",
            updated_at: "2026-01-20T00:00:00Z",
          },
        ],
        limit: 200,
        offset: 0,
        total: 1,
      }),
    });

    const node = await WorkflowOverlapExplorerPage({
      appBasePath: "javascript:alert(1)",
      searchParams: {},
      testIdPrefix: "workflow-overlap-explorer",
    });

    renderWithIntl(node);

    expect(screen.queryByRole("link", { name: "overlapExplorer.actions.openTemplates" })).toBeNull();
    expect(
      screen.queryByRole("link", { name: "overlapExplorer.results.openWorkflow" })
    ).toBeNull();
  });
});
