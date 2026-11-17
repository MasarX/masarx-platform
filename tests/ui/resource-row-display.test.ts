import { resolveColumns } from "../../packages/ui/src/resource-page-utils";

const list = {
  resource: "shipments",
  items: [] as Record<string, unknown>[],
  limit: 25,
  offset: 0,
};

test("Arabic column metadata changes display labels only", () => {
  const resource = {
    key: "shipments",
    relation: "shipments",
    column_labels: { status: "Status", sender: "Sender" },
    column_labels_ar: { status: "الحالة", sender: "المرسل" },
    columns: [
      { key: "status", label: "Current status", label_ar: "الحالة الحالية" },
      { key: "sender" },
    ],
  };
  expect(resolveColumns(resource, list, "ar").map(({ key, label }) => [key, label]))
    .toEqual([["status", "الحالة الحالية"], ["sender", "المرسل"]]);
  expect(resolveColumns(resource, list, "en").map(({ key, label }) => [key, label]))
    .toEqual([["status", "Current status"], ["sender", "Sender"]]);
});

test("missing Arabic metadata falls back to English without changing keys", () => {
  const resource = {
    key: "shipments",
    relation: "shipments",
    column_labels: { status: "Status" },
    columns: [{ key: "status" }],
  };
  expect(resolveColumns(resource, list, "ar")).toEqual(
    expect.arrayContaining([expect.objectContaining({ key: "status", label: "Status" })])
  );
});
