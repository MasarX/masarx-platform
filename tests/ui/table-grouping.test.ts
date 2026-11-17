import {
  buildGroupTree,
  flattenGroupTree,
  type GroupLabels,
} from "../../packages/ui/src/table/grouping";

const labels: GroupLabels = { empty: "Empty", all: "All" };

test("group headers prefer readable references for uuid values", () => {
  const rows = [
    { id: "row-1", sender_id: "123e4567-e89b-12d3-a456-426614174000" },
    { id: "row-2", sender_id: "123e4567-e89b-12d3-a456-426614174000" },
  ];

  const tree = buildGroupTree(rows, ["sender_id"], labels);
  expect(tree).toHaveLength(1);
  expect(tree[0]?.label).toBe("REF-123E4000");
  expect(tree[0]?.key).toContain("sender_id:123e4567-e89b-12d3-a456-426614174000");

  const flattened = flattenGroupTree(tree);
  const header = flattened.find((row) => row.type === "group");
  expect(header).toBeDefined();
  if (!header || header.type !== "group") return;
  expect(header.label).toBe("REF-123E4000");
});

test("group headers preserve non-uuid values", () => {
  const rows = [{ id: "row-1", status: "in_transit" }];
  const tree = buildGroupTree(rows, ["status"], labels);
  expect(tree).toHaveLength(1);
  expect(tree[0]?.label).toBe("in_transit");
});
