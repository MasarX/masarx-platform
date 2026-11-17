import { screen } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import { CommandCatalogPage } from "../../packages/ui/src/command-catalog-page";

jest.mock("next/navigation", () => ({
  usePathname: () => "/commands",
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(() => ({
    me: jest.fn().mockResolvedValue({ capabilities: [] })
  }))
}));

jest.mock("../../packages/ui/src/command-registry", () => ({
  fetchCommandRegistry: jest.fn()
}));

const { fetchCommandRegistry } = jest.requireMock(
  "../../packages/ui/src/command-registry"
) as { fetchCommandRegistry: jest.Mock };

beforeEach(() => {
  fetchCommandRegistry.mockReset();
});

test("command catalog shows empty state when no commands", async () => {
  fetchCommandRegistry.mockResolvedValue({ commands: [], error: null });

  const element = await CommandCatalogPage({
    appKey: "console",
    appLabel: "Console",
    testIdPrefix: "console-commands",
    appBasePath: "/console"
  });

  renderWithIntl(element as React.ReactElement);

  expect(
    screen.getByText("No commands configured for this scope.")
  ).toBeInTheDocument();
});

test("command catalog shows filtered empty state", async () => {
  fetchCommandRegistry.mockResolvedValue({
    commands: [
      {
        key: "shipments.create",
        label: "Create shipment",
        workflow_key: "shipments.create",
        schema_category: "resource:shipments"
      }
    ],
    error: null
  });

  const element = await CommandCatalogPage({
    appKey: "console",
    appLabel: "Console",
    testIdPrefix: "console-commands",
    appBasePath: "/console",
    searchParams: { q: "missing" }
  });

  renderWithIntl(element as React.ReactElement);

  expect(
    screen.getByText("No commands match the current filters.")
  ).toBeInTheDocument();
});
