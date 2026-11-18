import { loadTrackingDataset } from "../../packages/ui/src/tracking-map-composer";

jest.mock("@masarx/api/server", () => ({ createUiServerClient: jest.fn() }));
const pin = (address = "a") => ({ id: "g", address_id: address, latitude: 24, longitude: 46, label: "<label>", source: null });
function fixture(pages: Record<string, { items: Record<string, unknown>[]; total: number; limit?: number }>) {
  return {
    me: jest.fn().mockResolvedValue({ user: { id: "actor" }, access_scope: { scope_type: "tenant", scope_id: "tenant-a" } }),
    settingsPreview: jest.fn().mockResolvedValue({ value: { default_page_size: 2, allowed_sizes: [2, 4], max_page_size: 4 } }),
    listResource: jest.fn().mockImplementation((resource, _filters, _limit, offset) => Promise.resolve(pages[`${resource}:${offset}`] ?? { items: [], total: 0 })),
  };
}
const load = (ui: ReturnType<typeof fixture>, params = {}) => loadTrackingDataset(params, ui as unknown as Parameters<typeof loadTrackingDataset>[1]);
describe("tracking map server composition", () => {
  it("does not require administrative preview and honors the server page limit", async () => {
    const ui = fixture({
      "tracking_geocode_pins:0": { items: [pin(), pin("b")], total: 3, limit: 2 },
      "tracking_geocode_pins:2": { items: [pin("c")], total: 3, limit: 2 },
    });
    ui.settingsPreview.mockRejectedValue(new Error("settings.read denied"));
    expect(await load(ui)).toMatchObject({ limit: 2, offset: 0, hasNext: true });
    expect(await load(ui, { offset: "2" })).toMatchObject({ limit: 2, offset: 2, hasNext: false });
    expect(ui.listResource).toHaveBeenLastCalledWith("tracking_geocode_pins", {}, 2, 2, { key: "id", direction: "asc" });
  });
  it("still propagates resource denial when preview is unavailable", async () => {
    const ui = fixture({});
    ui.settingsPreview.mockRejectedValue(new Error("settings.read denied"));
    ui.listResource.mockRejectedValue(new Error("addresses.read denied"));
    await expect(load(ui)).rejects.toThrow("addresses.read denied");
  });
  it("rejects an invalid server page limit", async () => {
    const ui = fixture({ "tracking_geocode_pins:0": { items: [pin()], total: 1, limit: 0 } });
    await expect(load(ui)).rejects.toThrow("tracking_invalid_page_limit");
  });
  it("preserves composite generic pins without requesting fallback or leaking actor metadata", async () => {
    const ui = fixture({ "tracking_geocode_pins:0": { items: [pin(), pin("b")], total: 2 } });
    const result = await load(ui);
    expect(result.pins).toHaveLength(2);
    expect(new Set(result.pins.map(p => p.id)).size).toBe(2);
    expect(result.pins[0].label).toBe("<label>");
    expect(ui.listResource).toHaveBeenCalledTimes(1);
    expect(ui.listResource).toHaveBeenCalledWith("tracking_geocode_pins", {}, 2, 0, { key: "id", direction: "asc" });
    expect(ui.settingsPreview).toHaveBeenCalledWith({ category: "ui_pagination", scopeType: "tenant", scopeId: "tenant-a" });
  });
  it("uses addresses only after successful empty geocodes", async () => {
    const ui = fixture({ "tracking_address_pins:0": { items: [pin()], total: 1 } });
    const result = await load(ui);
    expect(result.resource).toBe("tracking_address_pins");
    expect(result.pins[0].status).toBeNull();
    expect(ui.listResource.mock.calls.map(call => call[0])).toEqual(["tracking_geocode_pins", "tracking_address_pins"]);
  });
  it("preserves six shipment fields and one-sided cities without claiming filtered totals", async () => {
    const ui = fixture({ "tracking_shipments:0": { items: [{ id: "s1", tracking_number: "T", status: "created", origin_city: "A", destination_city: null, service_type: "standard", updated_at: "2026-09-11" }, { id: "s2", destination_city: "B" }], total: 3 } });
    const result = await load(ui);
    expect(result.locations[0]).toEqual({ id: "s1", trackingNumber: "T", status: "created", originCity: "A", destinationCity: null, serviceType: "standard", updatedAt: "2026-09-11" });
    expect(result.locations[1].destinationCity).toBe("B");
    expect(result.hasNext).toBe(true);
    expect(result).not.toHaveProperty("total");
  });
  it("keeps paging available when a shipment page has no cities", async () => {
    const ui = fixture({ "tracking_shipments:0": { items: [{ id: "s" }, { id: "t" }], total: 4 } });
    expect(await load(ui)).toMatchObject({ locations: [], datasetEmpty: false, hasNext: true });
  });
  it("resets an empty later page without switching datasets", async () => {
    const ui = fixture({ "tracking_geocode_pins:0": { items: [pin()], total: 1 } });
    const result = await load(ui, { offset: "8", limit: "999" });
    expect(result).toMatchObject({ resource: "tracking_geocode_pins", offset: 0, limit: 2 });
    expect(ui.listResource.mock.calls.every(call => call[0] === "tracking_geocode_pins")).toBe(true);
  });
  it.each([0, 1, 2])("does not treat query failure at stage %i as an empty dataset", async stage => {
    const ui = fixture({});
    ui.listResource.mockImplementation((_resource, _filters, _limit, _offset) => {
      if (ui.listResource.mock.calls.length === stage + 1) throw new Error("denied");
      return Promise.resolve({ items: [], total: 0 });
    });
    await expect(load(ui)).rejects.toThrow("denied");
    expect(ui.listResource).toHaveBeenCalledTimes(stage + 1);
  });
  it("rejects select-suppressed coordinates rather than falling back", async () => {
    const ui = fixture({ "tracking_geocode_pins:0": { items: [{ id: "g", address_id: "a" }], total: 1 } });
    await expect(load(ui)).rejects.toThrow("tracking_coordinates_unavailable");
    expect(ui.listResource).toHaveBeenCalledTimes(1);
  });
  it("binds actor and scope to a new dataset identity", async () => {
    const ui = fixture({ "tracking_geocode_pins:0": { items: [pin()], total: 1 } });
    const before = await load(ui);
    ui.me.mockResolvedValue({ user: { id: "actor-b" }, access_scope: { scope_type: "tenant", scope_id: "tenant-b" } });
    const after = await load(ui);
    expect(after.identity).not.toBe(before.identity);
  });
});
