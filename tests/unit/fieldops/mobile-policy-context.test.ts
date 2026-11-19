import type { UiMe } from "@masarx/api";

import { buildPolicyContextFromMe } from "../../../apps/fieldops/src/mobile-policy-context";

function makeMe(partial: Partial<UiMe>): UiMe {
  return partial as UiMe;
}

describe("buildPolicyContextFromMe", () => {
  test("returns an empty policy context when the user envelope is missing", () => {
    expect(buildPolicyContextFromMe(null)).toEqual({});
    expect(buildPolicyContextFromMe(undefined)).toEqual({});
  });

  test("uses organization and user identifiers from the me envelope", () => {
    const ctx = buildPolicyContextFromMe(
      makeMe({
        org: { id: "org-1" } as UiMe["org"],
        user: { id: "user-1" } as UiMe["user"],
      })
    );

    expect(ctx).toEqual({
      organization_id: "org-1",
      user_id: "user-1",
    });
  });

  test("uses tenant access scope as organization fallback only when org id is absent", () => {
    expect(
      buildPolicyContextFromMe(
        makeMe({
          access_scope: { scope_type: "tenant", scope_id: "org-from-scope" } as UiMe["access_scope"],
        })
      )
    ).toEqual({ organization_id: "org-from-scope" });

    expect(
      buildPolicyContextFromMe(
        makeMe({
          org: { id: "org-from-me" } as UiMe["org"],
          access_scope: { scope_type: "tenant", scope_id: "org-from-scope" } as UiMe["access_scope"],
        })
      )
    ).toEqual({ organization_id: "org-from-me" });
  });

  test.each([
    ["client", "client_id"],
    ["sender", "sender_id"],
    ["source", "webhook_source_id"],
    ["resource", "resource_id"],
  ])("maps %s access scope to %s", (scopeType, contextKey) => {
    const ctx = buildPolicyContextFromMe(
      makeMe({
        access_scope: { scope_type: ` ${scopeType.toUpperCase()} `, scope_id: " scoped-id " } as UiMe["access_scope"],
      })
    );

    expect(ctx).toEqual({ [contextKey]: "scoped-id" });
  });

  test("ignores blank or unknown scope values", () => {
    expect(
      buildPolicyContextFromMe(
        makeMe({
          user: { id: "user-1" } as UiMe["user"],
          access_scope: { scope_type: "warehouse", scope_id: "resource-1" } as UiMe["access_scope"],
        })
      )
    ).toEqual({ user_id: "user-1" });

    expect(
      buildPolicyContextFromMe(
        makeMe({
          access_scope: { scope_type: "client", scope_id: "   " } as UiMe["access_scope"],
        })
      )
    ).toEqual({});
  });
});
