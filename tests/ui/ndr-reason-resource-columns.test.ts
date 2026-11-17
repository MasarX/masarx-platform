import { resolveColumns } from "../../packages/ui/src/resource-page-utils";

test("resolveColumns uses the dispatch exception reason label for NDR task queues", () => {
  const resource = {
    key: "dispatch_exception_review",
    relation: "tasks",
    column_labels: { status_reason: "Dispatch exception reason" },
  };

  const columns = resolveColumns(resource, {
    resource: "dispatch_exception_review",
    keys: ["status_reason", "sla_due_at"],
    items: [],
    limit: 25,
    offset: 0,
  });

  expect(columns[0]).toEqual({
    key: "status_reason",
    label: "Dispatch exception reason",
  });
});
