import { suggestResourceKeys } from "../../packages/ui/src/resource-page-utils";

test("suggestResourceKeys returns close unique matches", () => {
  const suggestions = suggestResourceKeys(
    "shipmnts",
    [
      { key: "shipments" },
      { key: "shipment_labels" },
      { key: "labels" },
      { key: "shipments" },
    ],
    3
  );

  expect(suggestions).toContain("shipments");
  expect(suggestions).not.toContain("labels");
  expect(new Set(suggestions).size).toBe(suggestions.length);
});

test("suggestResourceKeys excludes the same normalized key", () => {
  const suggestions = suggestResourceKeys("SHIPMENTS", [
    { key: "shipments" },
    { key: "Shipments" },
    { key: "shipment_labels" },
  ]);

  expect(suggestions).toEqual(["shipment_labels"]);
});

test("suggestResourceKeys handles suffixed typo keys from navigation routes", () => {
  const suggestions = suggestResourceKeys(
    "shpments_missing",
    [{ key: "shipments" }, { key: "labels" }, { key: "tracking_events" }],
    3
  );

  expect(suggestions).toContain("shipments");
  expect(suggestions).not.toContain("labels");
});
