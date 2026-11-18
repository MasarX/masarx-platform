import {
  normalizeMobileV2Role,
  parseMobileV2ActiveRoleEnvelope,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";

describe("Mobile V2 active-role envelope", () => {
  test("normalizes supported role keys and rejects unknown values", () => {
    expect(normalizeMobileV2Role(" Driver ")).toBe("driver");
    expect(normalizeMobileV2Role("loader")).toBe("loader");
    expect(normalizeMobileV2Role("cashier")).toBeNull();
    expect(normalizeMobileV2Role(null)).toBeNull();
  });

  test("uses backend assigned roles instead of exposing sample roles", () => {
    const envelope = parseMobileV2ActiveRoleEnvelope(
      {
        active_role: "driver",
        assigned_roles: ["driver", "driver", "cashier"],
        organization_id: "08d59e17-82ae-47c4-b54a-4a6b86213dc4",
        switched_at: "2026-05-27T07:00:00.000Z",
      },
      "loader",
    );

    expect(envelope.activeRole).toBe("driver");
    expect(envelope.assignedRoles).toEqual(["driver"]);
    expect(envelope.organizationId).toBe("08d59e17-82ae-47c4-b54a-4a6b86213dc4");
    expect(envelope.switchedAt).toBe("2026-05-27T07:00:00.000Z");
  });

  test("falls back to the first assigned role when backend active_role is unavailable", () => {
    const envelope = parseMobileV2ActiveRoleEnvelope(
      {
        assigned_roles: ["rider", "driver"],
      },
      "loader",
    );

    expect(envelope.activeRole).toBe("rider");
    expect(envelope.assignedRoles).toEqual(["rider", "driver"]);
  });
});
