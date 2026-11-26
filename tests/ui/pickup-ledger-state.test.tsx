import { screen } from "@testing-library/react";
import { PickupRequestsPage } from "../../packages/ui/src/pickup-requests-page";
import { PickupWavesPage } from "../../packages/ui/src/pickup-waves-page";
import { renderWithIntl } from "./test-utils";

const readRpc = jest.fn();
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("@masarx/api/server", () => ({
  createUiServerClient: () => ({
    me: async () => ({ org: { id: "org-a" }, capabilities: [] }),
  }),
}));
jest.mock("@masarx/auth/server", () => ({ createServerClient: () => ({ rpc: readRpc }) }));

const emptyState = '[role="status"][aria-live="polite"]';

describe.each([
  { page: "pickup waves", loadPage: PickupWavesPage, testIdPrefix: "console-pickup-waves" },
  { page: "pickup requests", loadPage: PickupRequestsPage, testIdPrefix: "console-pickup-requests" },
])("$page ledger", ({ loadPage, testIdPrefix }) => {
  const props = { appKey: "console" as const, appBasePath: "/console", searchParams: {}, testIdPrefix };

  it("shows an error without an empty state or rows when the list fails", async () => {
    readRpc.mockResolvedValueOnce({ data: null, error: { message: "List load failed" } });
    const { container } = renderWithIntl(await loadPage(props));

    expect(screen.getByTestId(testIdPrefix + "-error")).toBeVisible();
    expect(container.querySelectorAll(emptyState)).toHaveLength(0);
    expect(screen.queryAllByRole("article", { hidden: true })).toHaveLength(0);
  });

  it("shows an empty state without an error when the list has no rows", async () => {
    readRpc.mockResolvedValueOnce({ data: [], error: null });
    const { container } = renderWithIntl(await loadPage(props));

    expect(container.querySelector(emptyState)).toBeVisible();
    expect(screen.queryByTestId(testIdPrefix + "-error")).not.toBeInTheDocument();
  });
});
