const ROLE_LABELS: Record<string, string> = {
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

export function resolveMobileRoleLabel(roleValue: unknown): string {
  if (typeof roleValue !== "string") return "Driver";
  const normalized = roleValue.trim().toLowerCase();
  if (!normalized) return "Driver";
  return ROLE_LABELS[normalized] ?? toTitleCase(normalized.replace(/[_-]+/g, " "));
}

export function resolveMobileRoleCode(roleLabel: unknown): string {
  if (typeof roleLabel !== "string") return "D";
  const trimmed = roleLabel.trim();
  if (!trimmed) return "D";
  return trimmed.charAt(0).toUpperCase();
}

export function resolveMobileShellHeaderTitle(appName: string, roleValue: unknown): string {
  const safeAppName = String(appName || "MasarX Field Ops").trim() || "MasarX Field Ops";
  const canonicalAppName = /^field\s*ops$/i.test(safeAppName)
    ? "MasarX Field Ops"
    : safeAppName;
  return `${canonicalAppName} \u00B7 ${resolveMobileRoleLabel(roleValue)}`;
}
