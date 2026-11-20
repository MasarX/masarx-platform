import type { ReactElement } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { revalidatePath } from "next/cache";
import { createUiServerClient } from "@masarx/api/server";
import { attachMarketplaceClient } from "../../packages/api/src/marketplace-client";
import { MarketplaceRequestCreatePage } from "../../packages/ui/src/marketplace-request-create-page";
import { renderWithIntl } from "./test-utils";

jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("@masarx/api/server", () => ({ createUiServerClient: jest.fn() }));

const organization = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const supplier = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const requestsHref = "/portal/marketplace/requests";
const prefix = "portal-marketplace-request-create";

const draftArgs = {
  p_request_kind_key: "shipment_batch",
  p_title: "Fixture request",
  p_summary: null,
  p_request_details: {},
  p_items: [],
  p_private_pool: [],
  p_expires_at: null,
  p_metadata: {
    source: "portal.marketplace.request_create",
    app_base_path: "/portal",
  },
};

async function renderPage() {
  const rpc = jest.fn().mockResolvedValueOnce({ ok: true, id: requestId, status: "draft" });
  jest.mocked(createUiServerClient)
    .mockReturnValueOnce({
      me: jest.fn().mockResolvedValue({ org: { id: organization } }),
      marketplaceRequestKindCatalog: jest.fn().mockResolvedValue({
        request_kinds: [{ kind_key: "shipment_batch", label: "Fixture shipment batch" }],
      }),
    } as unknown as ReturnType<typeof createUiServerClient>)
    .mockReturnValue(attachMarketplaceClient(rpc) as ReturnType<typeof createUiServerClient>);

  const page = await MarketplaceRequestCreatePage({
    appBasePath: "/portal",
    requestsHref,
    testIdPrefix: prefix,
  });
  renderWithIntl(page as ReactElement);
  const form = screen.getByTestId<HTMLFormElement>(`${prefix}-form`);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "  Fixture request  " },
  });
  return { form, rpc };
}

function fillPool(csv: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Private pool organization IDs" }), {
    target: { value: csv },
  });
}

describe("MarketplaceRequestCreatePage private pool", () => {
  beforeEach(() => jest.resetAllMocks());

  it("submits the CSV field and preserves the order and duplicates of trimmed, nonempty IDs", async () => {
    const { form, rpc } = await renderPage();
    rpc.mockResolvedValueOnce({ ok: true, status: "published" });
    const csv = ` , ${supplier} , ,\n ${organization}\t, ${supplier},  `;
    fillPool(csv);
    expect(new FormData(form).get("private_pool_csv")).toBe(csv);
    fireEvent.change(screen.getByRole("textbox", { name: "Summary" }), {
      target: { value: "  Fixture scope  " },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Publish immediately after create" }));
    fireEvent.submit(form);

    expect((await screen.findByTestId(`${prefix}-success`)).textContent)
      .toBe("Request created and published.");
    expect(rpc.mock.calls).toEqual([
      ["marketplace_request_create_v1", {
        ...draftArgs,
        p_summary: "Fixture scope",
        p_private_pool: [supplier, organization, supplier],
      }],
      ["marketplace_request_publish_v1", { p_request_id: requestId, p_release_state: null }],
    ]);
    expect(jest.mocked(revalidatePath).mock.calls).toEqual([
      [requestsHref], [`${requestsHref}/new`],
    ]);
  });

  it("sends an empty pool for delimiter-only input and keeps the request in draft", async () => {
    const { form, rpc } = await renderPage();
    fillPool(" ,\n, \t ");
    fireEvent.submit(form);

    expect((await screen.findByTestId(`${prefix}-success`)).textContent).toBe("Request created.");
    expect(rpc.mock.calls).toEqual([["marketplace_request_create_v1", draftArgs]]);
  });

  it.each([
    ["request_kind_key", null, "Request kind is required."],
    ["title", "   ", "Title is required."],
    ["payload_json", "[", "Unexpected end of JSON input"],
    ["payload_json", "[]", "Payload must be a JSON object."],
  ])("shows a validation error for %s = %j and sends no mutation", async (name, value, message) => {
    const { form, rpc } = await renderPage();
    const field = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
    if (value === null) field.removeAttribute("name");
    else field.value = value;
    fillPool(supplier);
    fireEvent.submit(form);

    expect((await screen.findByTestId(`${prefix}-error`)).textContent).toBe(message);
    expect(rpc).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("surfaces a create rejection and stops before publish", async () => {
    const { form, rpc } = await renderPage();
    rpc.mockReset().mockResolvedValueOnce({
      ok: false,
      error: { code: "fixture_rejection", message: "  Fixture request rejected.  " },
    });
    fillPool("  fixture-id  ");
    fireEvent.click(screen.getByRole("checkbox", { name: "Publish immediately after create" }));
    fireEvent.submit(form);

    expect((await screen.findByTestId(`${prefix}-error`)).textContent).toBe("Fixture request rejected.");
    expect(rpc.mock.calls).toEqual([
      ["marketplace_request_create_v1", { ...draftArgs, p_private_pool: ["fixture-id"] }],
    ]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("shows the create fallback if the client throws without a message", async () => {
    const { form, rpc } = await renderPage();
    rpc.mockReset().mockRejectedValueOnce(new Error());
    fillPool(supplier);
    fireEvent.submit(form);

    expect((await screen.findByTestId(`${prefix}-error`)).textContent)
      .toBe("Request creation failed before reaching the API.");
    expect(rpc.mock.calls).toEqual([
      ["marketplace_request_create_v1", { ...draftArgs, p_private_pool: [supplier] }],
    ]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a created draft if automatic publish throws", async () => {
    const { form, rpc } = await renderPage();
    rpc.mockRejectedValueOnce(new Error("Fixture publish unavailable."));
    fillPool(supplier);
    fireEvent.click(screen.getByRole("checkbox", { name: "Publish immediately after create" }));
    fireEvent.submit(form);

    expect((await screen.findByTestId(`${prefix}-success`)).textContent).toBe("Request created.");
    expect(rpc.mock.calls).toEqual([
      ["marketplace_request_create_v1", { ...draftArgs, p_private_pool: [supplier] }],
      ["marketplace_request_publish_v1", { p_request_id: requestId, p_release_state: null }],
    ]);
  });
});
