const path = require("node:path");
const index = require("../../../config/qa/local-dedicated-evidence-index.json");

test("each local evidence flow has exactly one manifest owner", () => {
  expect(index.entries.length).toBeGreaterThan(0);
  const flows = new Set();
  const manifests = new Set();

  for (const { lane, manifest_path: manifest, flow_ids: ids } of index.entries) {
    expect(lane).toBe(index.lane);
    expect(path.posix.normalize(manifest)).toBe(manifest);
    expect(manifest).toMatch(/^tmp\/[a-z0-9/_-]+\.json$/);
    expect(manifests.has(manifest)).toBe(false);
    manifests.add(manifest);
    expect(ids.length).toBeGreaterThan(0);

    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9_]+$/);
      expect(flows.has(id)).toBe(false);
      flows.add(id);
    }
  }
});
