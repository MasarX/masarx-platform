// Mobile FieldOps shell-cutover resolver - calls
// `resolve_mobile_shell_policy(p_active_role, p_context)` at boot to
// decide whether the V2 shell should mount for this device/tenant. The
// production native shell wraps this in a one-shot Promise during boot.
// A non-true policy result blocks the legacy shell instead of rendering
// V1, so production proof cannot accidentally continue on the retired
// runtime.
//
// Audit fix (2026-05-13 engineering/security P0 #1): V2 had no
// production native entry — only the `?v2=preview` web gate wired
// `MobileV2RpcProvider`. This module is the policy-driven cutover
// (`mobile_shell_policy.v2_enabled`) so production native devices can
// opt in per tenant without an app-store release. A false/missing policy
// is a visible cutover-blocked state, not a V1 fallback.

import type { SupabaseClient } from "@supabase/supabase-js";

import { newMobileV2TraceContext } from "./mobile-v2-trace-context";

export interface MobileShellPolicyEnvelope {
  /** When true, mount the V2 shell tree. Defaults to false on any error. */
  readonly v2_enabled: boolean;
  /** Optional cohort tag carried through from policy rows. */
  readonly rollout_cohort?: string | null;
  /** Echoed back from the resolver for audit traceability. */
  readonly active_role?: string;
  /** Settings ladder scope that resolved this value (`global` / `tenant` / etc.). */
  readonly scope_type?: string;
  readonly scope_id?: string | null;
}

export type MobileShellMountDecision =
  | {
      readonly kind: "v2";
      readonly badge: "V2 active";
      readonly title: "Mobile V2 active";
      readonly message: string;
      readonly scopeSummary: string;
    }
  | {
      readonly kind: "blocked";
      readonly badge: "V2 required";
      readonly title: "Mobile V2 required";
      readonly message: string;
      readonly scopeSummary: string;
    };

export interface ResolveMobileShellPolicyInput {
  /** Active supabase client; null short-circuits to the safe default. */
  readonly supabase: SupabaseClient | null;
  /** Active role hint for the resolver (default "driver"). */
  readonly activeRole?: string;
  /** Optional caller-supplied policy context (correlation id, etc.). */
  readonly context?: Record<string, unknown>;
  /**
   * Hard timeout before returning a V2-disabled envelope. Boot must not block forever
   * on a slow policy resolver — the default is 4s which is generous
   * for a healthy edge but bounded enough that a stalled network
   * doesn't keep the user on a splash screen.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4000;

const DEFAULT_V1_ENVELOPE: MobileShellPolicyEnvelope = Object.freeze({
  v2_enabled: false,
});

function normalizeScopeSummary(policy: MobileShellPolicyEnvelope | null | undefined): string {
  const scopeType = typeof policy?.scope_type === "string" ? policy.scope_type.trim() : "";
  const scopeId = typeof policy?.scope_id === "string" ? policy.scope_id.trim() : "";
  if (scopeType && scopeId) return `${scopeType}:${scopeId}`;
  if (scopeType) return scopeType;
  return "unresolved";
}

export function resolveMobileShellMountDecision(
  policy: MobileShellPolicyEnvelope | null | undefined,
): MobileShellMountDecision {
  const scopeSummary = normalizeScopeSummary(policy);
  if (policy?.v2_enabled === true) {
    return Object.freeze({
      kind: "v2",
      badge: "V2 active",
      title: "Mobile V2 active",
      message: "The Mobile V2 runtime is enabled for this session.",
      scopeSummary,
    });
  }

  return Object.freeze({
    kind: "blocked",
    badge: "V2 required",
    title: "Mobile V2 required",
    message:
      "Mobile V2 could not be confirmed for this account. Check the device connection or ask an operator to enable this tenant, then retry.",
    scopeSummary,
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new Error("resolve_mobile_shell_policy timeout"));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(handle);
        reject(error);
      },
    );
  });
}

function parseEnvelope(raw: unknown): MobileShellPolicyEnvelope {
  if (raw === null || typeof raw !== "object") return DEFAULT_V1_ENVELOPE;
  const row = raw as Record<string, unknown>;
  const v2 = row.v2_enabled === true;
  const envelope: MobileShellPolicyEnvelope = {
    v2_enabled: v2,
    rollout_cohort:
      typeof row.rollout_cohort === "string" ? row.rollout_cohort : null,
    active_role:
      typeof row.active_role === "string" ? row.active_role : undefined,
    scope_type:
      typeof row.scope_type === "string" ? row.scope_type : undefined,
    scope_id:
      typeof row.scope_id === "string" ? row.scope_id : null,
  };
  return Object.freeze(envelope);
}

/**
 * Resolve the V2 shell cutover policy at boot.
 *
 * Failure modes are ALL absorbed as `{ v2_enabled: false }`: null
 * supabase client, RPC error, timeout, malformed payload, anything.
 * The boot path must never block on the policy. The caller converts a
 * non-true policy into a V2-required blocked state, not a V1 mount.
 */
export async function resolveMobileShellPolicy(
  input: ResolveMobileShellPolicyInput,
): Promise<MobileShellPolicyEnvelope> {
  const { supabase } = input;
  if (supabase === null) return DEFAULT_V1_ENVELOPE;

  const activeRole = input.activeRole ?? "driver";
  const trace = newMobileV2TraceContext();
  const context = {
    ...(input.context ?? {}),
    correlation_id: trace.correlationId,
  };
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const result = await withTimeout(
      Promise.resolve().then(() =>
        supabase.rpc("resolve_mobile_shell_policy", {
          p_active_role: activeRole,
          p_context: context,
        }),
      ),
      timeoutMs,
    );
    const { data, error } = result as {
      data: unknown;
      error: { message?: string } | null;
    };
    if (error !== null && error !== undefined) {
      return DEFAULT_V1_ENVELOPE;
    }
    return parseEnvelope(data);
  } catch {
    // Timeout, network error, or any other failure returns the
    // V2-disabled envelope. We
    // intentionally do NOT log to console here because the boot path
    // may run before the logger is fully initialized; the resolver's
    // own decision_log entry captures the authenticated path. For
    // unauthenticated / network-failure paths, the safe default is a
    // visible V2-required block rather than a legacy-shell fallback.
    return DEFAULT_V1_ENVELOPE;
  }
}

export const __TEST_ONLY = {
  parseEnvelope,
  DEFAULT_V1_ENVELOPE,
  normalizeScopeSummary,
};
