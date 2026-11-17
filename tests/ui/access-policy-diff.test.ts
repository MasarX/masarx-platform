import { summarizeAccessPolicyChanges } from "../../packages/ui/src/access-policy-diff";

const baseline = {
  capabilities: [
    { key: "shipments.read" },
    { key: "labels.read" },
  ],
  roles: [
    { key: "viewer", capability_keys: ["shipments.read"] },
    { key: "ops", capability_keys: ["labels.read"] },
  ],
  assignments: {
    user_type: {
      ops_admin: ["ops"],
    },
  },
  denies: [
    {
      capability_key: "shipments.delete",
      scope_type: "tenant",
      scope_id: "tenant-1",
      reason: "Freeze window",
    },
  ],
};

const updated = {
  capabilities: [
    { key: "shipments.read" },
    { key: "labels.read" },
    { key: "shipments.update" },
  ],
  roles: [
    { key: "viewer", capability_keys: ["shipments.read"] },
    { key: "ops", capability_keys: ["labels.read", "shipments.update"] },
    { key: "auditor", capability_keys: [] },
  ],
  assignments: {
    user_type: {
      ops_admin: ["ops", "auditor"],
    },
  },
  denies: [
    {
      capability_key: "shipments.delete",
      scope_type: "tenant",
      scope_id: "tenant-2",
      reason: "Audit window",
    },
  ],
};

test("summarizeAccessPolicyChanges reports capability, role, assignment diffs", () => {
  const diff = summarizeAccessPolicyChanges(baseline, updated);

  expect(diff?.capability.added).toEqual(["shipments.update"]);
  expect(diff?.capability.removed).toEqual([]);
  expect(diff?.role.added).toEqual(["auditor"]);
  expect(diff?.role.removed).toEqual([]);
  expect(diff?.role.updated).toEqual([
    { key: "ops", added: ["shipments.update"], removed: [] },
  ]);
  expect(diff?.assignments.userTypeChanged).toEqual(["ops_admin"]);
  expect(diff?.assignments.userIdChanged).toEqual([]);
  expect(diff?.denies.added).toEqual([
    "shipments.delete|tenant|tenant-2|Audit window",
  ]);
  expect(diff?.denies.removed).toEqual([
    "shipments.delete|tenant|tenant-1|Freeze window",
  ]);
});
