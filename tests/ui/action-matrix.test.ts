import { collectAccessibleResourceKeys } from "../e2e/utils/action-matrix";

const sections = [{
  id: "scope",
  items: [
    { id: "tenant", href: "/tenant", resource: "tenant_events" },
    { id: "platform", href: "/platform", resource: "platform_events" },
  ],
}];
const readRegistry = {
  resources: [
    {
      key: "tenant_events",
      relation: "public.tenant_events",
      read_scope_types: ["tenant"],
      scope_columns: { tenant: "organization_id" },
    },
    {
      key: "platform_events",
      relation: "public.platform_events",
      read_scope_types: ["platform"],
    },
  ],
};

test("navigation resources remain inside the authenticated read scope", () => {
  expect(collectAccessibleResourceKeys({
    sections,
    readRegistry,
    scopeType: "tenant",
    organizationId: "org",
  })).toEqual(["tenant_events"]);
  expect(collectAccessibleResourceKeys({
    sections,
    readRegistry,
    scopeType: "platform",
  })).toEqual(["platform_events"]);
});
