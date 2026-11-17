import { buildMobileMapListEntries, buildMobileRealMapModel, type MobileRealMapStop } from "../../../apps/fieldops/src/mobile-real-map-model";

const stop = (address: MobileRealMapStop["address"], id = "stop-1"): MobileRealMapStop => ({
  id, title: id, sequence: 1, active: false, address,
});
const valid = { validation_status: "valid", sa_short_code: "RNQA7082", coordinates: { latitude: 24.7, longitude: 46.6 } };

describe("mobile real map canonical address admission", () => {
  it.each(["pending", "invalid", "needs_review", "geocoded", undefined])("does not infer address approval from %s", (validation_status) => {
    expect(buildMobileRealMapModel([stop({ ...valid, validation_status })]).count).toBe(0);
  });
  it.each([
    null, {}, { latitude: 24.7 }, { longitude: 46.6 },
    { latitude: NaN, longitude: 46.6 }, { latitude: Infinity, longitude: 46.6 },
    { latitude: 91, longitude: 46.6 }, { latitude: 24.7, longitude: -181 },
    { latitude: "24.7", longitude: 46.6 },
  ])("rejects incomplete or malformed same-address coordinates %j (case %#)", (coordinates) => {
    expect(buildMobileRealMapModel([stop({ ...valid, coordinates })]).count).toBe(0);
  });
  it("requires usable address text or short code and preserves zero coordinates", () => {
    expect(buildMobileRealMapModel([stop({ ...valid, sa_short_code: " " })]).count).toBe(0);
    const model = buildMobileRealMapModel([stop({ ...valid, sa_short_code: "", line1: "Address", coordinates: { latitude: 0, longitude: 0 } })]);
    expect(model.points.features[0].geometry.coordinates).toEqual([0, 0]);
  });
  it("projects exact geographic points and active identity without percentage coordinates", () => {
    const model = buildMobileRealMapModel([{ ...stop(valid), active: true }]);
    expect(model.count).toBe(1);
    expect(model.points.features[0]).toMatchObject({
      id: "stop-1", properties: { id: "stop-1", active: true },
      geometry: { type: "Point", coordinates: [46.6, 24.7] },
    });
    expect(model.bounds).toEqual({ southwest: [46.6, 24.7], northeast: [46.6, 24.7] });
    expect(model.routeLine.features).toEqual([]);
  });
  it("joins only sequenced accepted stops and keeps unknown sequence points visible", () => {
    const first = { ...stop(valid, "first"), sequence: 1 };
    const second = { ...stop({ ...valid, coordinates: { latitude: 25, longitude: 47 } }, "second"), sequence: 2 };
    const unknown = { ...stop(valid, "unknown"), sequence: null };
    const model = buildMobileRealMapModel([second, unknown, first]);
    expect(model.count).toBe(3);
    expect(model.routeLine.features[0].geometry.coordinates).toEqual([[46.6, 24.7], [47, 25]]);
  });
  it("deduplicates identity and changes model identity when selected source changes", () => {
    const original = buildMobileRealMapModel([stop(valid), stop(valid)]);
    expect(original.count).toBe(1);
    expect(buildMobileRealMapModel([stop(valid)]).id).toBe(original.id);
    expect(buildMobileRealMapModel([{ ...stop(valid), active: true }]).id).not.toBe(original.id);
  });
  it("reports unprojectable poles without clamping them into invented marker positions", () => {
    const model = buildMobileRealMapModel([stop({ ...valid, coordinates: { latitude: 90, longitude: 180 } })]);
    expect(model.bounds).toBeNull();
    expect(model.count).toBe(0);
    expect(model.excludedCount).toBe(1);
  });
});

describe("map and keyboard list share full canonical address source", () => {
  it("retains canonical-only and nonmappable rows without filtering the alternative list", () => {
    const items = [
      { id: "canonical", destination_address: valid },
      { id: "unmapped", destination_address: { ...valid, coordinates: null } },
    ];
    const entries = buildMobileMapListEntries(items);
    expect(entries.map((entry) => entry.item)).toEqual(items);
    expect(entries[0].coords).toEqual({ latitude: 24.7, longitude: 46.6 });
    expect(entries[1].coords).toBeNull();
    const model = buildMobileRealMapModel(entries.map((entry) => stop(entry.address, entry.item.id as string)));
    expect(model.points.features.map((point) => point.properties.id)).toEqual(["canonical"]);
    expect(model.excludedCount).toBe(1);
  });
  it("explicit live null never falls back to older task or top-level address", () => {
    const item = { id: "cleared", destination_address: null, metadata: { address: valid }, address: valid };
    const [entry] = buildMobileMapListEntries([item]);
    expect(entry.item).toBe(item);
    expect(entry.address).toBeNull();
    expect(entry.coords).toBeNull();
    expect(buildMobileRealMapModel([stop(entry.address)]).count).toBe(0);
  });
  it("task snapshot null clears older top-level address while an actual task snapshot remains usable", () => {
    const entries = buildMobileMapListEntries([
      { id: "cleared", metadata: { address: null }, address: valid },
      { id: "task", metadata: { address: valid } },
    ]);
    expect(entries[0].address).toBeNull();
    expect(entries[1].coords).toEqual({ latitude: 24.7, longitude: 46.6 });
    expect(entries).toHaveLength(2);
  });
});

describe("map context preserves authoritative values", () => {
  it("preserves optional ETA and status without fabricating missing values", () => {
    const model = buildMobileRealMapModel([
      { ...stop(valid, "done"), status: "completed", etaMinutes: 0 },
      { ...stop(valid, "issue"), status: "failed", etaMinutes: 2.5 },
      { ...stop(valid, "unknown"), status: null },
    ]);
    expect(model.points.features.map((point) => [point.properties.status, point.properties.tone, point.properties.etaMinutes]))
      .toEqual([["completed", "done", 0], ["failed", "issue", 2.5], [null, "neutral", null]]);
    expect(model.count).toBe(3); // Co-located records retain their independent identities.
  });
  it.each([-1, NaN, Infinity, "5", undefined])("does not display unsupported ETA %s", (etaMinutes) => {
    const model = buildMobileRealMapModel([{ ...stop(valid), etaMinutes: etaMinutes as number }]);
    expect(model.points.features[0].properties.etaMinutes).toBeNull();
  });
  it("binds context changes to the existing model identity", () => {
    const original = buildMobileRealMapModel([stop(valid)]);
    expect(buildMobileRealMapModel([{ ...stop(valid), status: "done" }]).id).not.toBe(original.id);
    expect(buildMobileRealMapModel([{ ...stop(valid), etaMinutes: 5 }]).id).not.toBe(original.id);
  });
});
