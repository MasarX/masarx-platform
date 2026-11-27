import { loadPickupLookups, pickupLookupLabel } from "../../packages/ui/src/pickup-lookups";
import { createUiServerClient } from "@masarx/api/server";
import { loadPickupRequestRows } from "../../packages/ui/src/pickup-page-shared";

jest.mock("@masarx/api/server", () => ({ createUiServerClient: jest.fn() }));
jest.mock("../../packages/ui/src/pickup-page-shared", () => ({ loadPickupRequestRows: jest.fn() }));
const listResource = jest.fn();
const rpc = jest.fn();
const getResource = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  (createUiServerClient as jest.Mock).mockReturnValue({ listResource, rpc, getResource });
  listResource.mockResolvedValue({ items: [], limit: 100 });
  rpc.mockResolvedValue([]);
  (loadPickupRequestRows as jest.Mock).mockResolvedValue({ rows: [], error: null });
});

test("request choices use current tenant and client scope and preserve sender parent IDs", async () => {
  listResource.mockImplementation(async (kind) => ({ items: kind === "senders"
    ? [{ id: "sender", name: "Warehouse", client_id: "client" }] : [], limit: 100 }));
  const result = await loadPickupLookups({ org: { id: "tenant" },
    access_scope: { scope_type: "client", scope_id: "client" } }, "request");
  expect(listResource).toHaveBeenCalledWith("clients", { organization_id: "tenant", id: "client" }, 100, 0);
  expect(listResource).toHaveBeenCalledWith("senders", { organization_id: "tenant", client_id: "client" }, 100, 0);
  expect(result.options.senders).toEqual([{ value: "sender", label: "Warehouse", groupValue: "client" }]);
  expect(rpc).not.toHaveBeenCalled();
});

test("sender scope resolves its authorized parent before requesting client options", async () => {
  getResource.mockResolvedValue({ client_id: "parent" });
  await loadPickupLookups({ access_scope: { scope_type: "sender", scope_id: "sender" } }, "request");
  expect(getResource).toHaveBeenCalledWith("senders", "sender");
  expect(listResource).toHaveBeenCalledWith("clients", { id: "parent" }, 100, 0);
  expect(listResource).toHaveBeenCalledWith("senders", { client_id: "parent", id: "sender" }, 100, 0);
});

test("fails closed when sender parent cannot be read", async () => {
  getResource.mockRejectedValue(new Error("scope denied"));
  const result = await loadPickupLookups({ access_scope: { scope_type: "sender", scope_id: "sender" } }, "request");
  expect(result.error).toBe("Sender scope unavailable.");
  expect(result.error).not.toContain("scope denied");
  expect(listResource).not.toHaveBeenCalled();
});

test("wave choices use canonical active vehicle RPC and scoped pending pickup ledger", async () => {
  rpc.mockResolvedValue([{ vehicle_id: "vehicle", label: "Truck 42" }]);
  (loadPickupRequestRows as jest.Mock).mockResolvedValue({ rows: [
    { shipment_id: "shipment", tracking_number: "PU42" }], error: null });
  const result = await loadPickupLookups({ org: { id: "tenant" } }, "wave");
  expect(rpc).toHaveBeenCalledWith("pickup_vehicle_lookup_v1", { p_organization_id: "tenant", p_limit: 250 });
  expect(loadPickupRequestRows).toHaveBeenCalledWith({ clientId: "", senderId: "", status: "pickup_requested", limit: 250 });
  expect(listResource).toHaveBeenCalledWith("users", { organization_id: "tenant", user_type: "driver", status: "active" }, 100, 0);
  expect(result.options.vehicles).toEqual([{ value: "vehicle", label: "Truck 42" }]);
  expect(result.options.shipments).toEqual([{ value: "shipment", label: "PU42" }]);
});

test("continues across backend-capped pages and deduplicates choices", async () => {
  listResource.mockImplementation(async (_kind, _filters, _limit, offset) => ({
    items: offset === 0 ? [{ id: "one", name: "First" }] : [], limit: 1,
  }));
  const result = await loadPickupLookups({}, "request");
  expect(listResource).toHaveBeenCalledWith("clients", {}, 100, 1);
  expect(result.options.clients).toEqual([{ value: "one", label: "First" }]);
});

test("lookup failures remain visible and never fall back to unrestricted queries", async () => {
  listResource.mockRejectedValue(new Error("read denied"));
  const result = await loadPickupLookups({ org: { id: "tenant" } }, "request");
  expect(result.error).toBe("Unable to load clients choices. Unable to load senders choices. Unable to load branches choices.");
  expect(result.error).not.toContain("read denied");
  expect(result.options.clients).toEqual([]);
  expect(listResource).toHaveBeenCalledTimes(3);
});

test("does not query without a session", async () => {
  expect((await loadPickupLookups(null, "wave")).error).toContain("session");
  expect(createUiServerClient).not.toHaveBeenCalled();
});

test("uses human tracking and fleet labels", () => {
  expect(pickupLookupLabel({ tracking_number: "PU45", id: "uuid" }, "shipments")).toBe("PU45");
  expect(pickupLookupLabel({ full_name: "Example Person", email: "driver@example.test" }, "drivers")).toBe("Example Person");
});


test("an actor may select its own authoritative scope without parent enumeration permission", async () => {
  listResource.mockRejectedValue(new Error("parent enumeration denied"));
  const result = await loadPickupLookups({ access_scope: {
    scope_type: "client", scope_id: "client-owned", scope_label: "Own client",
  } }, "request");
  expect(result.options.clients).toEqual([{ value: "client-owned", label: "Own client" }]);
  expect(listResource).toHaveBeenCalledWith("clients", { id: "client-owned" }, 100, 0);
});
