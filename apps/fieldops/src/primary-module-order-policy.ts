// Resolve primary module ordering from primary_module_order_policy.
//
// Contract: the resolver `public.resolve_primary_module_order_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     order:                  ["home","tasks","route","scan","location","outbox","more"],
//     order_with_settlements: ["home","tasks","route","scan","location","outbox","settlements","more"]
//   }
//
// This module:
//  1. Defines the typed shape (PrimaryModuleOrderPolicyValue).
//  2. Normalizes the JSONB into a strict-typed object (defensive parse).
//  3. Exposes `resolvePrimaryModuleOrder(includeSettlements, policy?)` — the
//     consumer-facing helper that the App.tsx drawer/tab bar calls. If the
//     policy argument is omitted it falls back to STATIC_PRIMARY_MODULE_ORDER,
//     preserving the historical literal behavior bit-for-bit when the network
//     resolver query is in flight, offline, or returns a malformed row.
//  4. Ships a STATIC fallback that mirrors the global default seed exactly.
//
//
// Backward compat: STATIC_PRIMARY_MODULE_ORDER + STATIC_PRIMARY_MODULE_ORDER_WITH_SETTLEMENTS
// MUST stay in sync with the migration global default seed in
// supabase/migrations/202604241830_primary_module_order_policy_v1.sql.
// The pgTAP test 0zd_primary_module_order_policy.sql asserts the seed values.
// The Jest test tests/unit/primary-module-order-policy.test.ts asserts that
// these constants match the historical App.tsx literal exactly.

// All canonical primary module keys the Field Ops mobile shell knows about.
// `settlements` is treated specially because it is an opt-in module; consumers
// pass `includeSettlements: true` when the tenant has settlements enabled.
export type PrimaryModuleKey =
  | "home"
  | "tasks"
  | "route"
  | "scan"
  | "location"
  | "outbox"
  | "more"
  | "settlements";

export type PrimaryModuleOrderPolicyValue = {
  version: number;
  order: PrimaryModuleKey[];
  order_with_settlements: PrimaryModuleKey[];
};

// The set of valid primary module keys — used to filter out garbage entries
// from a malformed policy row before they pollute the drawer/tab bar order.
const VALID_PRIMARY_MODULE_KEYS: ReadonlySet<PrimaryModuleKey> = new Set([
  "home",
  "tasks",
  "route",
  "scan",
  "location",
  "outbox",
  "more",
  "settlements",
]);

// Mirror of the migration seed (see supabase/migrations/202604241830_primary_module_order_policy_v1.sql)
// AND a bit-for-bit mirror of the historical App.tsx PRIMARY_MODULE_HINT_ORDER
// literal so behavior is identical when the policy resolver returns the global
// default (or is offline / pre-fetch). The Jest test below pins this contract.
export const STATIC_PRIMARY_MODULE_ORDER: readonly PrimaryModuleKey[] = [
  "home",
  "tasks",
  "route",
  "scan",
  "location",
  "outbox",
  "more",
] as const;

export const STATIC_PRIMARY_MODULE_ORDER_WITH_SETTLEMENTS: readonly PrimaryModuleKey[] = [
  "home",
  "tasks",
  "route",
  "scan",
  "location",
  "outbox",
  "settlements",
  "more",
] as const;

export const STATIC_PRIMARY_MODULE_ORDER_POLICY: PrimaryModuleOrderPolicyValue = {
  version: 1,
  order: [...STATIC_PRIMARY_MODULE_ORDER],
  order_with_settlements: [...STATIC_PRIMARY_MODULE_ORDER_WITH_SETTLEMENTS],
};

// Filter an arbitrary array down to recognized PrimaryModuleKey entries,
// dropping duplicates and preserving original order. Returns null if the
// input is not an array OR has zero valid entries — caller decides whether
// to fall back to the static seed.
function sanitizeOrderArray(raw: unknown): PrimaryModuleKey[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<PrimaryModuleKey>();
  const out: PrimaryModuleKey[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (!VALID_PRIMARY_MODULE_KEYS.has(trimmed as PrimaryModuleKey)) continue;
    const key = trimmed as PrimaryModuleKey;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.length === 0 ? null : out;
}

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// PrimaryModuleOrderPolicyValue. Defensive: invalid module keys / duplicates
// are dropped, and if either order list is empty/malformed we fall back to the
// static seed so a bad row in production cannot brick the drawer/tab bar.
export function normalizePrimaryModuleOrderPolicy(
  raw: unknown,
): PrimaryModuleOrderPolicyValue {
  if (!raw || typeof raw !== "object") {
    return {
      version: STATIC_PRIMARY_MODULE_ORDER_POLICY.version,
      order: [...STATIC_PRIMARY_MODULE_ORDER_POLICY.order],
      order_with_settlements: [...STATIC_PRIMARY_MODULE_ORDER_POLICY.order_with_settlements],
    };
  }
  const obj = raw as Record<string, unknown>;
  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw) ? versionRaw : 1;

  const orderClean = sanitizeOrderArray(obj.order);
  const orderWithSettlementsClean = sanitizeOrderArray(obj.order_with_settlements);

  return {
    version,
    order: orderClean ?? [...STATIC_PRIMARY_MODULE_ORDER_POLICY.order],
    order_with_settlements:
      orderWithSettlementsClean ??
      [...STATIC_PRIMARY_MODULE_ORDER_POLICY.order_with_settlements],
  };
}

// The static ordering keeps navigation stable while the resolver query is in flight.
export function resolvePrimaryModuleOrder(
  includeSettlements: boolean,
  policy?: PrimaryModuleOrderPolicyValue | null,
): PrimaryModuleKey[] {
  const effective = policy ?? STATIC_PRIMARY_MODULE_ORDER_POLICY;
  return includeSettlements
    ? [...effective.order_with_settlements]
    : [...effective.order];
}
