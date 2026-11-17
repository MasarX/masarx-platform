import type { ReactElement } from "react";
import { createUiServerClient } from "@masarx/api/server";
import { MarketplaceContractRoomPage } from "../../packages/ui/src/marketplace-contract-room-page";
import { renderWithIntl } from "./test-utils";

jest.mock("@masarx/api/server", () => ({ createUiServerClient: jest.fn() }));
jest.mock("../../packages/ui/src/marketplace-action-form", () => ({
  MarketplaceActionForm: () => null,
}));

const mockCreateUiServerClient = createUiServerClient as jest.Mock;

describe("MarketplaceContractRoomPage settlement references", () => {
  it.each([
    ["unnamed UUID", { organization_id: "550e8400-e29b-41d4-a716-446655440099" }, "REF-550E0099"],
    ["named organization", { organization_name: "Rush Logistics", organization_id: "550e8400-e29b-41d4-a716-446655440099" }, "Rush Logistics"],
    ["short reference", { organization_id: "org-short" }, "org-short"],
    ["blank reference", { organization_id: " " }, ""],
  ] as Array<[string, Record<string, string>, string]>)("preserves %s display through the shared contract room", async (_case, settlement, expected) => {
    mockCreateUiServerClient.mockReturnValue({
      marketplaceContractRoom: jest.fn().mockResolvedValue({
        ok: true,
        contract: { id: "contract-1", terms: {} },
        settlements: [{ id: "settlement-1", ...settlement }],
      }),
    });
    const node = await MarketplaceContractRoomPage({
      appBasePath: "/portal", contractId: "contract-1",
      contractsHref: "/portal/marketplace/contracts", testIdPrefix: "contract-room",
    });
    const { container, queryByText } = renderWithIntl(node as ReactElement);
    const reference = container.querySelector(".mt-3");
    expect(reference).not.toBeNull();
    expect(reference?.textContent).toBe(expected);
    expect(queryByText("550e8400-e29b-41d4-a716-446655440099")).not.toBeInTheDocument();
    expect(mockCreateUiServerClient().marketplaceContractRoom).toHaveBeenCalledWith({
      contractId: "contract-1",
    });
  });
});
