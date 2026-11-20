import {
  buildFilterTreeFromFlat,
  flattenFilterTree,
  normalizeFlatFilterValue,
} from "../../packages/ui/src/resource-query";

test("flat saved-view NOT IN filters become canonical array not-equal rules", () => {
  const tree = buildFilterTreeFromFlat(
    { status: "NOT IN:delivered,cancelled" },
    [{ key: "status", column: "status", op: "eq" }]
  );

  expect(flattenFilterTree(tree)).toEqual([
    expect.objectContaining({
      key: "status",
      op: "ne",
      value: ["delivered", "cancelled"],
    }),
  ]);
});

test("flat saved-view IN filters become canonical array equals rules", () => {
  expect(normalizeFlatFilterValue("IN:pending,in_transit")).toEqual({
    op: "eq",
    value: ["pending", "in_transit"],
  });
});

test("flat saved-view literal filters keep the registry default operator", () => {
  const tree = buildFilterTreeFromFlat(
    { status: "in_progress" },
    [{ key: "status", column: "status", op: "eq" }]
  );

  expect(flattenFilterTree(tree)).toEqual([
    expect.objectContaining({
      key: "status",
      op: "eq",
      value: "in_progress",
    }),
  ]);
});
