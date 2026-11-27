// Mobile V2 POD policy parser + helpers — defensively reads the
// mobile_pod_policy payload returned by
// resolve_settings_row_from_policy_context_v1('mobile_pod_policy', ctx).value
// and exposes typed methods + fail-reason taxonomy with per-reason gating
// flags. Per AGENTS.md Mobile Field Ops Policy Contract: "POD methods + fail
// reasons are row-driven through mobile_pod_policy; reason flags
// (reattempt, photo, note, escalate, codOnly, region, requires) drive UI
// gating dynamically. No hardcoded reason taxonomy in client code."
//
// All functions are pure. Bad payloads degrade to safe empty defaults
// rather than throwing — frontend should always be able to render the POD
// screen, even with corrupted policy.

import { EN_STRINGS, type FieldOpsStrings } from "./i18n";

export type MobileV2PodMethod =
  | "scan"
  | "photo"
  | "sig"
  | "otp"
  | "id"
  | "cod";

export interface MobileV2PodFailReason {
  /** Stable reason code persisted in events / decision_log. */
  readonly code: string;
  /** Human-readable label shown in UI. */
  readonly label: string;
  /** Reason permits driver to reattempt later (queues for retry). */
  readonly reattempt: boolean;
  /** Reason requires a photo before submit. */
  readonly photo: boolean;
  /** Reason requires a note. */
  readonly note: boolean;
  /** Reason escalates to dispatch / supervisor. */
  readonly escalate: boolean;
  /** Reason only valid for COD shipments (e.g. cod_unpaid). */
  readonly codOnly: boolean;
}

export interface MobileV2PodPolicy {
  readonly version: number;
  readonly methods: ReadonlyArray<MobileV2PodMethod>;
  readonly failReasons: ReadonlyArray<MobileV2PodFailReason>;
  readonly codCurrency: string;
}

export interface MobileV2PodProofCheckpointLike {
  readonly key?: unknown;
}

const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "scan",
  "photo",
  "sig",
  "otp",
  "id",
  "cod",
]);

export const MOBILE_V2_POD_DEFAULT_POLICY: MobileV2PodPolicy = Object.freeze({
  version: 1,
  methods: Object.freeze(["scan", "photo", "sig"] as const),
  failReasons: Object.freeze([
    Object.freeze({
      code: "recipient_unavailable",
      label: EN_STRINGS.pod.reasonRecipientUnavailable,
      reattempt: true,
      photo: false,
      note: true,
      escalate: false,
      codOnly: false,
    }),
    Object.freeze({
      code: "address_not_found",
      label: EN_STRINGS.pod.reasonAddressNotFound,
      reattempt: true,
      photo: true,
      note: true,
      escalate: false,
      codOnly: false,
    }),
    Object.freeze({
      code: "access_restricted",
      label: EN_STRINGS.pod.reasonAccessRestricted,
      reattempt: true,
      photo: false,
      note: true,
      escalate: false,
      codOnly: false,
    }),
    Object.freeze({
      code: "parcel_damaged",
      label: EN_STRINGS.pod.reasonParcelDamaged,
      reattempt: false,
      photo: true,
      note: true,
      escalate: true,
      codOnly: false,
    }),
    Object.freeze({
      code: "cod_unpaid",
      label: EN_STRINGS.pod.reasonCodUnpaid,
      reattempt: true,
      photo: false,
      note: true,
      escalate: false,
      codOnly: true,
    }),
  ]),
  codCurrency: "SAR",
});

const DEFAULT_FAIL_REASON_LABEL_KEYS: Readonly<Record<string, keyof FieldOpsStrings["pod"]>> = Object.freeze({
  recipient_unavailable: "reasonRecipientUnavailable",
  address_not_found: "reasonAddressNotFound",
  access_restricted: "reasonAccessRestricted",
  parcel_damaged: "reasonParcelDamaged",
  cod_unpaid: "reasonCodUnpaid",
});

/**
 * Display label for a fail reason. Only the built-in default labels are
 * translated; a label that came from the policy row is shown as written.
 */
export function resolveMobileV2PodFailReasonLabel(
  reason: MobileV2PodFailReason,
  strings: FieldOpsStrings = EN_STRINGS,
): string {
  const key = DEFAULT_FAIL_REASON_LABEL_KEYS[reason.code];
  if (key === undefined || reason.label !== EN_STRINGS.pod[key]) return reason.label;
  return strings.pod[key];
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function asMethodArray(value: unknown): ReadonlyArray<MobileV2PodMethod> {
  if (!Array.isArray(value)) return MOBILE_V2_POD_DEFAULT_POLICY.methods;
  const out: MobileV2PodMethod[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && ALLOWED_METHODS.has(entry)) {
      out.push(entry as MobileV2PodMethod);
    }
  }
  if (out.length === 0) return MOBILE_V2_POD_DEFAULT_POLICY.methods;
  // De-dupe while preserving order.
  const seen = new Set<string>();
  const dedup: MobileV2PodMethod[] = [];
  for (const m of out) {
    if (!seen.has(m)) {
      seen.add(m);
      dedup.push(m);
    }
  }
  return Object.freeze(dedup);
}

export function parseMobileV2PodFailReason(value: unknown): MobileV2PodFailReason | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const code = asString(r.code);
  const label = asString(r.label);
  if (code === null || label === null) return null;
  return Object.freeze({
    code,
    label,
    reattempt: asBool(r.reattempt),
    photo: asBool(r.photo),
    note: asBool(r.note),
    escalate: asBool(r.escalate),
    // Schema uses snake_case (cod_only) per JSON Schema; accept either form
    // in case operators hand-edit the policy row.
    codOnly: asBool(r.codOnly) || asBool(r.cod_only),
  });
}

function asReasonArray(value: unknown): ReadonlyArray<MobileV2PodFailReason> {
  if (!Array.isArray(value)) return MOBILE_V2_POD_DEFAULT_POLICY.failReasons;
  const out: MobileV2PodFailReason[] = [];
  const seenCodes = new Set<string>();
  for (const entry of value) {
    const reason = parseMobileV2PodFailReason(entry);
    if (reason !== null && !seenCodes.has(reason.code)) {
      seenCodes.add(reason.code);
      out.push(reason);
    }
  }
  if (out.length === 0) return MOBILE_V2_POD_DEFAULT_POLICY.failReasons;
  return Object.freeze(out);
}

/** Parse the full mobile_pod_policy row.value JSONB; never throws. */
export function parseMobileV2PodPolicy(value: unknown): MobileV2PodPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return MOBILE_V2_POD_DEFAULT_POLICY;
  }
  const r = value as Record<string, unknown>;
  const versionRaw = r.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw) && versionRaw >= 1
      ? Math.floor(versionRaw)
      : MOBILE_V2_POD_DEFAULT_POLICY.version;
  const codCurrency = asString(r.cod_currency) ?? asString(r.codCurrency) ?? MOBILE_V2_POD_DEFAULT_POLICY.codCurrency;
  return Object.freeze({
    version,
    methods: asMethodArray(r.methods),
    failReasons: asReasonArray(r.fail_reasons ?? r.failReasons),
    codCurrency,
  });
}

// ---------------------------------------------------------------------------
// Policy-driven UI gating
// ---------------------------------------------------------------------------

/** True when the policy declares the given method as supported. */
export function podPolicyHasMethod(
  policy: MobileV2PodPolicy,
  method: MobileV2PodMethod,
): boolean {
  return policy.methods.includes(method);
}

/** True when COD method is in policy AND the shipment carries a COD amount. */
export function podPolicyAllowsCod(
  policy: MobileV2PodPolicy,
  input: { readonly hasCod: boolean },
): boolean {
  if (!podPolicyHasMethod(policy, "cod")) return false;
  return input.hasCod;
}

export function resolveMobileV2PodMethodsForStop(
  policy: MobileV2PodPolicy,
  proofChecklist: ReadonlyArray<MobileV2PodProofCheckpointLike>,
): ReadonlyArray<MobileV2PodMethod> {
  const out: MobileV2PodMethod[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string" || !ALLOWED_METHODS.has(value) || seen.has(value)) {
      return;
    }
    seen.add(value);
    out.push(value as MobileV2PodMethod);
  };

  for (const method of policy.methods) add(method);
  for (const checkpoint of proofChecklist) add(checkpoint.key);

  return Object.freeze(out);
}

export function resolveMobileV2PodPolicyForStop(
  policy: MobileV2PodPolicy,
  proofChecklist: ReadonlyArray<MobileV2PodProofCheckpointLike>,
): MobileV2PodPolicy {
  return Object.freeze({
    ...policy,
    methods: resolveMobileV2PodMethodsForStop(policy, proofChecklist),
  });
}

export interface PodSubmitGate {
  readonly canSubmit: boolean;
  readonly missing: ReadonlyArray<"photo" | "note" | "escalate_ack">;
}

/**
 * Determine whether the user can submit a fail-reason action given which
 * artefacts have been collected. The reason flags drive UI gating
 * dynamically so the policy row is the only source of truth.
 */
export function resolvePodSubmitGate(
  reason: MobileV2PodFailReason,
  input: {
    readonly hasPhoto: boolean;
    readonly hasNote: boolean;
    readonly escalateAcknowledged: boolean;
  },
): PodSubmitGate {
  const missing: Array<"photo" | "note" | "escalate_ack"> = [];
  if (reason.photo && !input.hasPhoto) missing.push("photo");
  if (reason.note && !input.hasNote) missing.push("note");
  if (reason.escalate && !input.escalateAcknowledged) missing.push("escalate_ack");
  return {
    canSubmit: missing.length === 0,
    missing: Object.freeze(missing),
  };
}

/**
 * Filter the policy fail-reason list down to those valid for the current
 * shipment context. cod-only reasons are dropped when the shipment has no
 * COD amount.
 */
export function filterPodFailReasons(
  policy: MobileV2PodPolicy,
  context: { readonly hasCod: boolean },
): ReadonlyArray<MobileV2PodFailReason> {
  return policy.failReasons.filter((reason) => {
    if (reason.codOnly && !context.hasCod) return false;
    return true;
  });
}
