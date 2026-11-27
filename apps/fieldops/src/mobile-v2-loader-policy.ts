// Mobile V2 Loader policy parser — defensively reads the
// mobile_loader_policy payload returned by
// resolve_settings_row_from_policy_context_v1('mobile_loader_policy', ctx).value
// and exposes typed scan modes + per-hub enabled action catalog. Per
// AGENTS.md Mobile Field Ops Policy Contract: "Loader scan actions are
// row-driven through mobile_loader_policy: per-hub enabledActions (subset
// of actions[] catalog) plus defaultMode (single/bulk) and confirmThreshold.
// No hardcoded action lists in the loader scan screen."

import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import { MOBILE_V2_ICON_NAMES } from "./mobile-v2-icon-specs";
import { EN_STRINGS, type FieldOpsStrings } from "./i18n";

export type MobileV2LoaderScanMode = "single" | "bulk";

export interface MobileV2LoaderAction {
  /** Stable key (e.g. 'load', 'unload', 'verify'). */
  readonly key: string;
  readonly label: string;
  readonly icon: MobileV2IconName;
  /**
   * Backend executor for actions that are production-wired. Actions without
   * this field remain selectable but must not be routed through another flow.
   */
  readonly submitRpc?: string | null;
}

export interface MobileV2LoaderSessionContext {
  readonly bay: string;
  readonly waveLabel: string | null;
  readonly routeLabel: string | null;
  readonly cutOff: string | null;
}

export interface MobileV2LoaderPolicy {
  readonly version: number;
  readonly scanModes: ReadonlyArray<MobileV2LoaderScanMode>;
  readonly defaultMode: MobileV2LoaderScanMode;
  /** Full catalog of actions known to the system. */
  readonly actions: ReadonlyArray<MobileV2LoaderAction>;
  /** Per-hub subset of actions[].key that are currently enabled. */
  readonly enabledActions: ReadonlyArray<string>;
  /** Default action key when the screen mounts. */
  readonly defaultAction: string;
  readonly contextChips: ReadonlyArray<string>;
  /** Above this scan count the bulk-mode submit asks for confirmation. */
  readonly confirmThreshold: number;
  readonly soundEnabled: boolean;
  readonly hapticOnScan: boolean;
  readonly sessionContext: MobileV2LoaderSessionContext | null;
}

const ALLOWED_MODES: ReadonlySet<string> = new Set(["single", "bulk"]);
const ICON_SET: ReadonlySet<string> = new Set(MOBILE_V2_ICON_NAMES as ReadonlyArray<string>);

const DEFAULT_ACTIONS: ReadonlyArray<MobileV2LoaderAction> = Object.freeze([
  Object.freeze({ key: "load", label: EN_STRINGS.loaderScan.actions.load, icon: "truck" }),
  Object.freeze({ key: "unload", label: EN_STRINGS.loaderScan.actions.unload, icon: "package" }),
  Object.freeze({ key: "receive", label: EN_STRINGS.loaderScan.actions.receive, icon: "box" }),
  Object.freeze({ key: "sort", label: EN_STRINGS.loaderScan.actions.sort, icon: "split", submitRpc: "induct_fieldops_parcel_v1" }),
  Object.freeze({ key: "verify", label: EN_STRINGS.loaderScan.actions.verify, icon: "check-double" }),
  Object.freeze({ key: "damage", label: EN_STRINGS.loaderScan.actions.damage, icon: "alert" }),
  Object.freeze({ key: "shelve", label: EN_STRINGS.loaderScan.actions.shelve, icon: "layers" }),
  Object.freeze({ key: "inter_hub_transfer", label: EN_STRINGS.loaderScan.actions.inter_hub_transfer, icon: "route" }),
]);

export const MOBILE_V2_LOADER_DEFAULT_POLICY: MobileV2LoaderPolicy = Object.freeze({
  version: 1,
  scanModes: Object.freeze(["single", "bulk"] as const),
  defaultMode: "single",
  actions: DEFAULT_ACTIONS,
  enabledActions: Object.freeze(["load", "unload", "receive", "sort"]),
  defaultAction: "sort",
  contextChips: Object.freeze(["route", "bay"]),
  confirmThreshold: 25,
  soundEnabled: true,
  hapticOnScan: true,
  sessionContext: null,
});

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (value === true) return true;
  if (value === false) return false;
  return fallback;
}

function asNumberInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return fallback;
}

function asMode(value: unknown, fallback: MobileV2LoaderScanMode): MobileV2LoaderScanMode {
  if (typeof value === "string" && ALLOWED_MODES.has(value)) {
    return value as MobileV2LoaderScanMode;
  }
  return fallback;
}

function asModeArray(value: unknown): ReadonlyArray<MobileV2LoaderScanMode> {
  if (!Array.isArray(value)) return MOBILE_V2_LOADER_DEFAULT_POLICY.scanModes;
  const out: MobileV2LoaderScanMode[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" && ALLOWED_MODES.has(entry) && !seen.has(entry)) {
      seen.add(entry);
      out.push(entry as MobileV2LoaderScanMode);
    }
  }
  if (out.length === 0) return MOBILE_V2_LOADER_DEFAULT_POLICY.scanModes;
  return Object.freeze(out);
}

export function parseMobileV2LoaderAction(value: unknown): MobileV2LoaderAction | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const key = asString(r.key);
  const label = asString(r.label);
  if (key === null || label === null) return null;
  const iconRaw = asString(r.icon);
  const icon: MobileV2IconName = iconRaw !== null && ICON_SET.has(iconRaw) ? (iconRaw as MobileV2IconName) : "package";
  const submitRpc = asString(r.submit_rpc ?? r.submitRpc);
  if (submitRpc === null) return Object.freeze({ key, label, icon });
  return Object.freeze({ key, label, icon, submitRpc });
}

function asActionArray(value: unknown): ReadonlyArray<MobileV2LoaderAction> {
  if (!Array.isArray(value)) return DEFAULT_ACTIONS;
  const out: MobileV2LoaderAction[] = [];
  const seenKeys = new Set<string>();
  for (const entry of value) {
    const action = parseMobileV2LoaderAction(entry);
    if (action !== null && !seenKeys.has(action.key)) {
      seenKeys.add(action.key);
      out.push(action);
    }
  }
  if (out.length === 0) return DEFAULT_ACTIONS;
  return Object.freeze(out);
}

function asKeyArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0 && !seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  return Object.freeze(out);
}

export function parseMobileV2LoaderSessionContext(value: unknown): MobileV2LoaderSessionContext | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const bay = asString(r.bay ?? r.active_bay ?? r.activeBay ?? r.bay_id ?? r.bayId);
  if (bay === null) return null;
  return Object.freeze({
    bay,
    waveLabel: asString(r.wave_label ?? r.waveLabel ?? r.wave),
    routeLabel: asString(r.route_label ?? r.routeLabel ?? r.route),
    cutOff: asString(r.cut_off ?? r.cutOff ?? r.cutoff),
  });
}

/** Parse the full mobile_loader_policy row.value JSONB; never throws. */
export function parseMobileV2LoaderPolicy(value: unknown): MobileV2LoaderPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return MOBILE_V2_LOADER_DEFAULT_POLICY;
  }
  const r = value as Record<string, unknown>;
  const versionRaw = r.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw) && versionRaw >= 1
      ? Math.floor(versionRaw)
      : MOBILE_V2_LOADER_DEFAULT_POLICY.version;
  const scanModes = asModeArray(r.scan_modes ?? r.scanModes);
  const defaultMode = asMode(
    r.default_mode ?? r.defaultMode,
    MOBILE_V2_LOADER_DEFAULT_POLICY.defaultMode,
  );
  const actions = asActionArray(r.actions);
  const enabledRaw = asKeyArray(r.enabled_actions ?? r.enabledActions);
  // enabledActions must be a subset of action keys; drop anything that
  // doesn't match a known action.
  const actionKeys = new Set(actions.map((a) => a.key));
  const enabledFiltered = enabledRaw.filter((k) => actionKeys.has(k));
  const enabledActions =
    enabledFiltered.length > 0
      ? Object.freeze(enabledFiltered)
      : MOBILE_V2_LOADER_DEFAULT_POLICY.enabledActions.filter((k) => actionKeys.has(k));
  const defaultActionRaw = asString(r.default_action ?? r.defaultAction);
  const defaultAction =
    defaultActionRaw !== null && actionKeys.has(defaultActionRaw) && enabledActions.includes(defaultActionRaw)
      ? defaultActionRaw
      : enabledActions[0] ?? MOBILE_V2_LOADER_DEFAULT_POLICY.defaultAction;
  return Object.freeze({
    version,
    scanModes,
    defaultMode,
    actions,
    enabledActions: Object.freeze([...enabledActions]),
    defaultAction,
    contextChips: asKeyArray(r.context_chips ?? r.contextChips),
    confirmThreshold: asNumberInt(
      r.confirm_threshold ?? r.confirmThreshold,
      MOBILE_V2_LOADER_DEFAULT_POLICY.confirmThreshold,
    ),
    soundEnabled: asBool(
      r.sound_enabled ?? r.soundEnabled,
      MOBILE_V2_LOADER_DEFAULT_POLICY.soundEnabled,
    ),
    hapticOnScan: asBool(
      r.haptic_on_scan ?? r.hapticOnScan,
      MOBILE_V2_LOADER_DEFAULT_POLICY.hapticOnScan,
    ),
    sessionContext: parseMobileV2LoaderSessionContext(r.session_context ?? r.sessionContext),
  });
}

// ---------------------------------------------------------------------------
// Policy-driven UI helpers
// ---------------------------------------------------------------------------

/** Returns the loader actions that are both in the catalog AND enabled per hub. */
export function getEnabledLoaderActions(
  policy: MobileV2LoaderPolicy,
): ReadonlyArray<MobileV2LoaderAction> {
  const enabledSet = new Set(policy.enabledActions);
  return policy.actions.filter((a) => enabledSet.has(a.key));
}

/**
 * Returns true when the bulk submit should pop a confirm dialog. UX rule
 * from design source: confirm above policy.confirmThreshold scans.
 */
export function shouldConfirmLoaderBulkSubmit(
  policy: MobileV2LoaderPolicy,
  input: { readonly scanCount: number; readonly mode: MobileV2LoaderScanMode },
): boolean {
  if (input.mode !== "bulk") return false;
  return input.scanCount > policy.confirmThreshold;
}

/**
 * Display label for a loader action. The built-in default label (English
 * catalog text) is shown in the active locale; any other label came from the
 * policy row and is shown as-is.
 */
export function loaderActionLabel(
  action: MobileV2LoaderAction,
  strings: FieldOpsStrings = EN_STRINGS,
): string {
  const defaults: Readonly<Record<string, string>> = EN_STRINGS.loaderScan.actions;
  const localized: Readonly<Record<string, string>> = strings.loaderScan.actions;
  return defaults[action.key] === action.label ? localized[action.key] ?? action.label : action.label;
}

/** True when an action key is currently enabled for this hub. */
export function isLoaderActionEnabled(
  policy: MobileV2LoaderPolicy,
  actionKey: string,
): boolean {
  return policy.enabledActions.includes(actionKey);
}

/**
 * Resolve the effective action key for a screen state. If the requested key
 * is missing or disabled, fall back to the policy default; if even that is
 * missing, fall back to the first enabled action.
 */
export function resolveEffectiveLoaderAction(
  policy: MobileV2LoaderPolicy,
  requestedKey: string | null | undefined,
): string {
  if (requestedKey !== null && requestedKey !== undefined && isLoaderActionEnabled(policy, requestedKey)) {
    return requestedKey;
  }
  if (isLoaderActionEnabled(policy, policy.defaultAction)) {
    return policy.defaultAction;
  }
  return policy.enabledActions[0] ?? "load";
}

/**
 * Returns the row-declared backend executor for the effective action.
 * `null` means the action is visible/configured but not yet submit-capable.
 */
export function getLoaderActionSubmitRpc(
  policy: MobileV2LoaderPolicy,
  requestedKey: string | null | undefined,
): string | null {
  const effectiveKey = resolveEffectiveLoaderAction(policy, requestedKey);
  const action = policy.actions.find((candidate) => candidate.key === effectiveKey);
  return action?.submitRpc ?? null;
}
