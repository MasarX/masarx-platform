import {
  loadShipmentCreateClientOptions,
  loadShipmentCreateSenderOptions,
} from "../../packages/ui/src/shipment-create-relation-lookups";

const organizationId = "organization-a";
const clientId = "550e8400-e29b-41d4-a716-446655440000";
const senderId = "550e8400-e29b-41d4-a716-446655440001";

describe("shipment create relation lookups", () => {
  test("searches client names and slugs in the active organization and filters results by friendly label", async () => {
    const client = { id: "client-a", name: "Example Client", slug: "example-client" };
    const listResource = jest.fn()
      .mockResolvedValueOnce({ items: [client, { id: "client-b", name: "Other Client" }] })
      .mockResolvedValueOnce({ items: [client] });

    const options = await loadShipmentCreateClientOptions({ listResource }, "Example Client", 100, organizationId);

    expect(listResource.mock.calls).toEqual([
      ["clients", { organization_id: organizationId, name: "%Example Client%" }, 100],
      ["clients", { organization_id: organizationId, slug: "%example-client%" }, 100],
    ]);
    expect(options).toEqual([{ value: "client-a", label: "Example Client" }]);
  });

  test("does not load client options without an organization context", async () => {
    const listResource = jest.fn();

    await expect(loadShipmentCreateClientOptions({ listResource }, "Example")).resolves.toEqual([]);

    expect(listResource).not.toHaveBeenCalled();
  });

  test("falls back to a friendly client reference during a partial search", async () => {
    const listResource = jest.fn().mockResolvedValue({ items: [{ id: clientId, name: "", slug: "" }] });

    const options = await loadShipmentCreateClientOptions({ listResource }, "550e", 100, organizationId);

    expect(listResource.mock.calls).toEqual([
      ["clients", { organization_id: organizationId, name: "%550e%" }, 100],
      ["clients", { organization_id: organizationId, slug: "%550e%" }, 100],
    ]);
    expect(options).toEqual([{ value: clientId, label: "Client REF-550E0000" }]);
    expect(options[0]?.label).not.toBe(clientId);
  });

  test("uses the scoped id filter for a diagnostic UUID search", async () => {
    const listResource = jest.fn().mockResolvedValue({ items: [{ id: clientId, name: "", slug: "" }] });

    const options = await loadShipmentCreateClientOptions({ listResource }, clientId, 100, organizationId);

    expect(listResource.mock.calls).toEqual([
      ["clients", { organization_id: organizationId, id: clientId }, 100],
    ]);
    expect(options).toEqual([{ value: clientId, label: "Client REF-550E0000" }]);
    expect(options[0]?.label).not.toBe(clientId);
  });

  test("loads client options within the active organization when the search is empty", async () => {
    const listResource = jest.fn().mockResolvedValue({ items: [{ id: "client-a", name: "Example Client" }] });

    const options = await loadShipmentCreateClientOptions({ listResource }, "", 20, organizationId);

    expect(listResource.mock.calls).toEqual([["clients", { organization_id: organizationId }, 20]]);
    expect(options).toEqual([{ value: "client-a", label: "Example Client" }]);
  });

  test("loads senders with the canonical client scope and matches the brand label locally", async () => {
    const listResource = jest.fn().mockResolvedValue({
      items: [
        { id: "sender-a", name: "Sender Ops", brand_name: "Example Sender" },
        { id: "sender-b", name: "Warehouse Sender", brand_name: "Other Sender" },
      ],
    });

    const options = await loadShipmentCreateSenderOptions({ listResource }, "client-a", "Example Sender");

    expect(listResource).toHaveBeenCalledWith("senders", { client_id: "client-a" }, 100);
    expect(options).toEqual([{ value: "sender-a", label: "Sender Ops" }]);
  });

  test("falls back to a friendly sender reference label", async () => {
    const listResource = jest.fn().mockResolvedValue({ items: [{ id: senderId, name: "", brand_name: "" }] });

    const options = await loadShipmentCreateSenderOptions({ listResource }, "client-a", senderId);

    expect(options).toEqual([{ value: senderId, label: "Sender REF-550E0001" }]);
    expect(options[0]?.label).not.toBe(senderId);
  });
});
