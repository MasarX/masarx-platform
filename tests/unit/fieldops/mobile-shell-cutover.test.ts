// Unit coverage for the V2 shell-cutover resolver. Audit fix
// (2026-05-13 engineering/security P0 #1).

import {
  resolveMobileShellMountDecision,
  resolveMobileShellPolicy,
  __TEST_ONLY,
} from "../../../apps/fieldops/src/mobile-shell-cutover";
import { buildPolicyContextFromMe } from "../../../apps/fieldops/src/mobile-policy-context";

const { parseEnvelope, DEFAULT_V1_ENVELOPE, normalizeScopeSummary } = __TEST_ONLY;

function makeSupabaseStub(rpcImpl: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>) {
  return { rpc: rpcImpl } as unknown as Parameters<typeof resolveMobileShellPolicy>[0]["supabase"];
}

describe("resolveMobileShellPolicy — V2 cutover safety", () => {
  test("null supabase short-circuits to a V2-disabled envelope", async () => {
    const env = await resolveMobileShellPolicy({ supabase: null });
    expect(env.v2_enabled).toBe(false);
    expect(env).toEqual(DEFAULT_V1_ENVELOPE);
  });

  test("rpc error returns a V2-disabled envelope", async () => {
    const supabase = makeSupabaseStub(async () => ({
      data: null,
      error: { message: "42501: RLS denial" },
    }));
    const env = await resolveMobileShellPolicy({ supabase });
    expect(env.v2_enabled).toBe(false);
  });

  test("rpc returns v2_enabled=true → V2 envelope honored", async () => {
    const supabase = makeSupabaseStub(async () => ({
      data: { v2_enabled: true, rollout_cohort: "early", scope_type: "tenant" },
      error: null,
    }));
    const env = await resolveMobileShellPolicy({ supabase });
    expect(env.v2_enabled).toBe(true);
    expect(env.rollout_cohort).toBe("early");
    expect(env.scope_type).toBe("tenant");
  });

  test("rpc returns v2_enabled missing as V2-disabled", async () => {
    const supabase = makeSupabaseStub(async () => ({
      data: { some_other_field: true },
      error: null,
    }));
    const env = await resolveMobileShellPolicy({ supabase });
    expect(env.v2_enabled).toBe(false);
  });

  test("rpc returns v2_enabled as string 'true' as V2-disabled (strict boolean only)", async () => {
    const supabase = makeSupabaseStub(async () => ({
      data: { v2_enabled: "true" },
      error: null,
    }));
    const env = await resolveMobileShellPolicy({ supabase });
    expect(env.v2_enabled).toBe(false);
  });

  test("timeout returns a V2-disabled envelope", async () => {
    const supabase = makeSupabaseStub(
      () =>
        new Promise(() => {
          /* never resolves */
        }),
    );
    const env = await resolveMobileShellPolicy({
      supabase,
      timeoutMs: 50,
    });
    expect(env.v2_enabled).toBe(false);
  });

  test("rpc throws returns V2-disabled envelope without propagating to boot path", async () => {
    const supabase = makeSupabaseStub(async () => {
      throw new Error("Network request failed");
    });
    const env = await resolveMobileShellPolicy({ supabase });
    expect(env.v2_enabled).toBe(false);
  });

  test("includes correlation_id in context (audit traceability)", async () => {
    let capturedArgs: Record<string, unknown> | null = null;
    const supabase = makeSupabaseStub(async (_name, args) => {
      capturedArgs = args as Record<string, unknown>;
      return { data: { v2_enabled: false }, error: null };
    });
    await resolveMobileShellPolicy({ supabase, activeRole: "loader" });
    const ctx = capturedArgs?.p_context as Record<string, unknown> | undefined;
    expect(typeof ctx?.correlation_id).toBe("string");
    expect(capturedArgs?.p_active_role).toBe("loader");
  });

  test("passes through caller-supplied context fields", async () => {
    let capturedArgs: Record<string, unknown> | null = null;
    const supabase = makeSupabaseStub(async (_name, args) => {
      capturedArgs = args as Record<string, unknown>;
      return { data: { v2_enabled: false }, error: null };
    });
    await resolveMobileShellPolicy({
      supabase,
      context: { device_id: "DEV-001" },
    });
    const ctx = capturedArgs?.p_context as Record<string, unknown> | undefined;
    expect(ctx?.device_id).toBe("DEV-001");
    // correlation_id is still injected alongside the caller's fields
    expect(typeof ctx?.correlation_id).toBe("string");
  });

  test("boot caller can pass authenticated tenant context so the V2 override is honored", async () => {
    let capturedArgs: Record<string, unknown> | null = null;
    const supabase = makeSupabaseStub(async (_name, args) => {
      capturedArgs = args as Record<string, unknown>;
      return {
        data: {
          v2_enabled: true,
          scope_type: "tenant",
          scope_id: "08d59e17-82ae-47c4-b54a-4a6b86213dc4",
        },
        error: null,
      };
    });

    const context = buildPolicyContextFromMe({
      org: { id: "08d59e17-82ae-47c4-b54a-4a6b86213dc4" },
      user: {
        id: "d64acf3e-7340-40c8-9833-49dbfe14f666",
        user_type: "driver",
      },
    } as Parameters<typeof buildPolicyContextFromMe>[0]);

    const env = await resolveMobileShellPolicy({
      supabase,
      activeRole: "driver",
      context,
    });

    const ctx = capturedArgs?.p_context as Record<string, unknown> | undefined;
    expect(ctx).toEqual(
      expect.objectContaining({
        organization_id: "08d59e17-82ae-47c4-b54a-4a6b86213dc4",
        user_id: "d64acf3e-7340-40c8-9833-49dbfe14f666",
      }),
    );
    expect(capturedArgs?.p_active_role).toBe("driver");
    expect(env.v2_enabled).toBe(true);
    expect(env.scope_type).toBe("tenant");
  });
});

describe("parseEnvelope helper", () => {
  test("non-object → default V1", () => {
    expect(parseEnvelope(null).v2_enabled).toBe(false);
    expect(parseEnvelope(undefined).v2_enabled).toBe(false);
    expect(parseEnvelope("a string").v2_enabled).toBe(false);
    expect(parseEnvelope(42).v2_enabled).toBe(false);
  });

  test("v2_enabled=true preserved", () => {
    expect(parseEnvelope({ v2_enabled: true }).v2_enabled).toBe(true);
  });

  test("ignores non-string scope_type / rollout_cohort", () => {
    const env = parseEnvelope({
      v2_enabled: true,
      scope_type: 42,
      rollout_cohort: { weird: true },
    });
    expect(env.v2_enabled).toBe(true);
    expect(env.scope_type).toBeUndefined();
    expect(env.rollout_cohort).toBeNull();
  });
});

describe("resolveMobileShellMountDecision", () => {
  test("mounts only the Mobile V2 runtime when v2_enabled is true", () => {
    const decision = resolveMobileShellMountDecision({
      v2_enabled: true,
      scope_type: "tenant",
      scope_id: "08d59e17-82ae-47c4-b54a-4a6b86213dc4",
    });
    expect(decision.kind).toBe("v2");
    expect(decision.badge).toBe("V2 active");
    expect(decision.scopeSummary).toBe("tenant:08d59e17-82ae-47c4-b54a-4a6b86213dc4");
  });

  test("blocks instead of exposing the retired V1 shell when policy is false", () => {
    const decision = resolveMobileShellMountDecision({
      v2_enabled: false,
      scope_type: "global",
    });
    expect(decision.kind).toBe("blocked");
    expect(decision.badge).toBe("V2 required");
    expect(decision.message).toContain("Mobile V2 could not be confirmed");
    expect(decision.message).not.toContain("mobile_shell_policy");
  });

  test("blocks unresolved resolver failures instead of falling back to V1", () => {
    const decision = resolveMobileShellMountDecision(null);
    expect(decision.kind).toBe("blocked");
    expect(decision.scopeSummary).toBe("unresolved");
  });

  test("scope summary is stable for policy audit copy", () => {
    expect(normalizeScopeSummary({ v2_enabled: true, scope_type: "tenant", scope_id: "tenant-1" }))
      .toBe("tenant:tenant-1");
    expect(normalizeScopeSummary({ v2_enabled: false, scope_type: "global", scope_id: null }))
      .toBe("global");
    expect(normalizeScopeSummary(undefined)).toBe("unresolved");
  });
});
