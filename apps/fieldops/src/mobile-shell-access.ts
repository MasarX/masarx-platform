type MobileNavItemLike = {
  label?: unknown;
  disabled_reason?: unknown;
  items?: MobileNavItemLike[] | null;
};

type MobileNavSectionLike = {
  items?: MobileNavItemLike[] | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function flattenEnabledLabels(items: MobileNavItemLike[] | null | undefined): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.disabled_reason == null) {
      const label = normalizeLabel(item.label);
      if (label) out.push(label);
    }
    if (Array.isArray(item.items)) out.push(...flattenEnabledLabels(item.items));
  }
  return out;
}

export function resolveModuleLabelsFromSections(
  sections: MobileNavSectionLike[] | null | undefined
): string[] {
  if (!Array.isArray(sections)) return [];
  const labels = sections.flatMap((section) => flattenEnabledLabels(section?.items));
  return Array.from(new Set(labels));
}

export function hasMobileSettlementAccess(capabilities: unknown): boolean {
  if (!Array.isArray(capabilities)) return false;
  const normalized = new Set(
    capabilities
      .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
      .filter(Boolean)
  );

  return (
    normalized.has("tasks.read") ||
    normalized.has("finance.read") ||
    normalized.has("settlements.read")
  );
}

export function resolveAccessScopeSummary(input: {
  scopeType: unknown;
  scopeId: unknown;
}): string {
  const scopeType = normalizeLabel(input.scopeType);
  const scopeId = normalizeLabel(input.scopeId);
  if (scopeType && scopeId) return `${scopeType}:${scopeId}`;
  if (scopeType) return scopeType;
  return "unknown";
}

export function formatMobileNavDisabledReason(reason: unknown): {
  title: string;
  message: string;
  badge: string;
} {
  if (reason == null) {
    return { title: "Unavailable", message: "This module is unavailable.", badge: "Unavailable" };
  }

  if (typeof reason === "string") {
    const normalized = reason.trim().toLowerCase();
    if (normalized.includes("missing_capability")) {
      return {
        title: "No access",
        message: "Your account does not have access to this module.",
        badge: "No access",
      };
    }
    return {
      title: "Unavailable",
      message: `This module is unavailable: ${reason}`,
      badge: "Unavailable",
    };
  }

  const input = asRecord(reason);
  const kindRaw = normalizeLabel(input.kind) ?? normalizeLabel(input.code) ?? normalizeLabel(input.reason);
  const kind = kindRaw ? kindRaw.toLowerCase() : "";
  const capability =
    normalizeLabel(input.capability) ??
    normalizeLabel(input.capability_key) ??
    normalizeLabel(input.required_capability) ??
    null;

  if (kind.includes("missing_capability") || capability) {
    const suffix = capability ? ` Missing capability: ${capability}.` : "";
    return {
      title: "No access",
      message: `Your account does not have access to this module.${suffix}`,
      badge: "No access",
    };
  }

  const details =
    normalizeLabel(input.message) ??
    normalizeLabel(input.detail) ??
    normalizeLabel(input.error) ??
    null;

  if (details) {
    return {
      title: "Unavailable",
      message: `This module is unavailable: ${details}`,
      badge: "Unavailable",
    };
  }

  return {
    title: "Unavailable",
    message: "This module is unavailable for your account.",
    badge: "Unavailable",
  };
}
