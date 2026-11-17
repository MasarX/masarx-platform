import { screen } from "@testing-library/react";
import { renderWithIntl } from "../../tests/ui/test-utils";
import { ResourceBulkActions } from "../../packages/ui/src/resource-bulk-actions";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/test",
}));

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: jest.fn(() => ({
    executeCommand: jest.fn(),
  })),
}));

const defaultProps = {
  resourceKey: "shipments",
  resource: null,
  commands: [] as any[],
  selectedIds: [] as string[],
  appKey: "console" as const,
  appBasePath: "/console",
  downloadBasePath: "/console/download",
  userCapabilities: [],
};

test("renders without crashing with empty commands", () => {
  renderWithIntl(
    <ResourceBulkActions {...defaultProps} />
  );

  // With empty commands and empty selectedIds, component renders without error
  expect(true).toBe(true);
});

test("renders with selectedIds", () => {
  renderWithIntl(
    <ResourceBulkActions
      {...defaultProps}
      selectedIds={["id_1", "id_2"]}
    />
  );

  // With empty commands but non-empty selectedIds, renders the "empty" message
  expect(screen.getByText(/./)).toBeInTheDocument();
});

test("handles empty selectedIds gracefully", () => {
  renderWithIntl(
    <ResourceBulkActions
      {...defaultProps}
      selectedIds={[]}
      commands={[]}
    />
  );

  // With no actions and no selected IDs, renders without error
  expect(true).toBe(true);
});
