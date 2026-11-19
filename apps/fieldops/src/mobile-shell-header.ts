// Default English presentation labels for known RBAC role codes. These
// are i18n fallbacks only — production should resolve the human label
// from the active locale catalog or from
// `rbac_user_role_assignments.display_name`, never from this map
// directly. The map exists so unknown English-locale renders pick up a
// pretty title-case label instead of the raw underscore_code. Per
// AGENTS.md "zero hardcoding", the absent-role default is the
// underscore_code itself (title-cased), not a hardcoded "Driver" — a
// missing role must never silently masquerade as a specific role.
const ROLE_LABELS_EN_FALLBACK: Record<string, string> = {
  driver: "Driver",
  warehouse: "Warehouse",
  cashier: "Cashier",
  ops_admin: "Ops Admin",
  account_manager: "Account Manager",
  client_admin: "Client Admin",
  sender_user: "Sender User",
  super_admin: "Super Admin",
};

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Resolve a presentation label for a role value. Returns:
 * - the i18n-catalog/RBAC-assigned label when integration ships
 * - a known English fallback for canonical role codes
 * - a title-cased version of the role code itself if unknown
 *
 * Never silently falls back to "Driver" — that would mask role-resolution
 * bugs by labelling unknown/empty roles as a specific role. Missing
 * roles render as an empty string so the shell header layout can react
 * to the unresolved state.
 */
export function resolveMobileRoleLabel(roleValue: unknown): string {
  if (typeof roleValue !== "string") return "";
  const normalized = roleValue.trim().toLowerCase();
  if (!normalized) return "";
  return (
    ROLE_LABELS_EN_FALLBACK[normalized] ??
    toTitleCase(normalized.replace(/[_-]+/g, " "))
  );
}

export function resolveMobileRoleCode(roleLabel: unknown): string {
  if (typeof roleLabel !== "string") return "";
  const trimmed = roleLabel.trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase();
}

export function resolveMobileShellHeaderTitle(appName: string, roleValue: unknown): string {
  const safeAppName = String(appName || "MasarX Field Ops").trim() || "MasarX Field Ops";
  const canonicalAppName = /^field\s*ops$/i.test(safeAppName)
    ? "MasarX Field Ops"
    : safeAppName;
  const roleLabel = resolveMobileRoleLabel(roleValue);
  return roleLabel ? `${canonicalAppName} \u00B7 ${roleLabel}` : canonicalAppName;
}
