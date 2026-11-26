import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UiCommandDefinition } from "@masarx/api";
import { renderWithIntl } from "./test-utils";
import { ResourceBulkActions } from "../../packages/ui/src/resource-bulk-actions";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/test",
}));

const rpcMock = jest.fn().mockResolvedValue({ status: "completed" });

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: () => ({ rpc: rpcMock }),
}));

const defaultProps = {
  resourceKey: "shipments",
  resource: null,
  commands: [],
  selectedIds: [] as string[],
  appKey: "console" as const,
  appBasePath: "/console",
  downloadBasePath: "/console/download",
  userCapabilities: [],
};

const refreshStatus: UiCommandDefinition = {
  key: "shipments.refresh_status",
  label: "Refresh shipment status",
  execution: { type: "rpc", rpc: "ui_execute_command_v1" },
  selection: { min_count: 1 },
};

const archiveShipments: UiCommandDefinition = {
  key: "shipments.archive",
  label: "Archive shipments",
  capability: "shipments.archive",
  execution: { type: "rpc", rpc: "ui_execute_command_v1" },
  selection: { min_count: 1 },
};

const selectedIds = ["shipment-1", "shipment-2"];

test("shows the empty-state message when selected rows have no actions", () => {
  renderWithIntl(
    <ResourceBulkActions {...defaultProps} selectedIds={selectedIds} />
  );

  expect(
    screen.getByText("No actions configured for this selection.")
  ).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("disables a named action when no rows are selected", () => {
  renderWithIntl(<ResourceBulkActions {...defaultProps} commands={[refreshStatus]} />);

  expect(
    screen.getByRole("button", { name: "Refresh shipment status" })
  ).toBeDisabled();
});

test("confirms the permitted action and disables the restricted action", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <ResourceBulkActions
      {...defaultProps}
      commands={[refreshStatus, archiveShipments]}
      selectedIds={selectedIds}
    />
  );

  const refreshButton = screen.getByRole("button", { name: "Refresh shipment status" });
  expect(refreshButton).toBeEnabled();
  expect(screen.getByRole("button", { name: "Archive shipments" })).toBeDisabled();

  await user.click(refreshButton);
  expect(rpcMock).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Confirm" }));

  expect(rpcMock).toHaveBeenCalledTimes(1);
  expect(rpcMock).toHaveBeenCalledWith("ui_execute_command_v1", {
    p_action_key: "shipments.refresh_status",
    p_resource_key: "shipments",
    p_selection_ids: selectedIds,
    p_selection_id: null,
    p_selection_count: 2,
    p_params: null,
  });
});
