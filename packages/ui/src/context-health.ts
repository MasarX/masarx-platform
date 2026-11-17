import { normalizeUiScopeType, type UiMe } from "@masarx/api";
import { resolveCapabilitySet, WILDCARD_CAPABILITY } from "./capabilities";
import { formatReferenceValue } from "./resource-utils";

export type ContextHealthStatus = "ok" | "warn" | "error";

export type ContextHealthCheck = {
  id: string;
  label: string;
  status: ContextHealthStatus;
  detail: string;
};

type ContextHealthInput = {
  me: UiMe | null;
  navigationCount: number;
  commandCount: number;
  resourceCount: number;
};

type ContextHealthTranslator = (
  key: string,
  values?: Record<string, string>
) => string;

const asCount = (value: number) => (Number.isFinite(value) ? value : 0);

export function buildContextHealthChecks({
  me,
  navigationCount,
  commandCount,
  resourceCount,
}: ContextHealthInput,
t: ContextHealthTranslator): ContextHealthCheck[] {
  const capabilitySet = resolveCapabilitySet(me?.capabilities);
  const hasWildcardCapability = capabilitySet.has(WILDCARD_CAPABILITY);
  const capabilitiesCount = capabilitySet.size;
  const capabilitiesLabel = hasWildcardCapability
    ? WILDCARD_CAPABILITY
    : String(capabilitiesCount);
  const scopeTypeRaw = me?.access_scope?.scope_type ?? null;
  const scopeType = normalizeUiScopeType(scopeTypeRaw);
  const scopeId = me?.access_scope?.scope_id ?? null;
  const scopeLabelRaw = me?.access_scope?.scope_label ?? null;
  const scopeLabel = scopeLabelRaw?.trim() ? scopeLabelRaw.trim() : null;
  const settingsResolutionId = me?.settings_resolution_id ?? null;
  const scopeReadableId = scopeId ? formatReferenceValue(scopeId) : null;
  const settingsReadableId = settingsResolutionId
    ? formatReferenceValue(settingsResolutionId)
    : null;

  const scopeHasIdentifier = Boolean(scopeId || scopeLabel);
  const isGlobalScope = scopeType === "global";
  const scopeStatus: ContextHealthStatus = !scopeType
    ? "error"
    : isGlobalScope || scopeHasIdentifier
      ? "ok"
      : "warn";
  const scopeDetail = scopeType
      ? isGlobalScope && !scopeHasIdentifier
      ? scopeType
      : t("healthChecks.scope.detail", {
          scopeType,
          scopeId: scopeLabel ?? scopeReadableId ?? t("unknown"),
        })
    : t("healthChecks.scope.missing");

  return [
    {
      id: "identity",
      label: t("healthChecks.identity.label"),
      status: me?.user?.id ? "ok" : "error",
      detail: me?.user?.email ?? me?.user?.id
        ? t("healthChecks.identity.detail", {
            user: me?.user?.email ?? me?.user?.id ?? t("unknown"),
          })
        : t("healthChecks.identity.missing"),
    },
    {
      id: "scope",
      label: t("healthChecks.scope.label"),
      status: scopeStatus,
      detail: scopeDetail,
    },
    {
      id: "capabilities",
      label: t("healthChecks.capabilities.label"),
      status: capabilitiesCount > 0 ? "ok" : "warn",
      detail:
        capabilitiesCount > 0
          ? t("healthChecks.capabilities.detail", {
              count: capabilitiesLabel,
            })
          : t("healthChecks.capabilities.missing"),
    },
    {
      id: "navigation",
      label: t("healthChecks.navigation.label"),
      status: asCount(navigationCount) > 0 ? "ok" : "warn",
      detail:
        asCount(navigationCount) > 0
          ? t("healthChecks.navigation.detail", {
              count: String(navigationCount),
            })
          : t("healthChecks.navigation.missing"),
    },
    {
      id: "commands",
      label: t("healthChecks.commands.label"),
      status: asCount(commandCount) > 0 ? "ok" : "warn",
      detail:
        asCount(commandCount) > 0
          ? t("healthChecks.commands.detail", {
              count: String(commandCount),
            })
          : t("healthChecks.commands.missing"),
    },
    {
      id: "resources",
      label: t("healthChecks.resources.label"),
      status: asCount(resourceCount) > 0 ? "ok" : "warn",
      detail:
        asCount(resourceCount) > 0
          ? t("healthChecks.resources.detail", {
              count: String(resourceCount),
            })
          : t("healthChecks.resources.missing"),
    },
    {
      id: "settings",
      label: t("healthChecks.settings.label"),
      status: settingsResolutionId ? "ok" : "warn",
      detail:
        settingsReadableId
          ? t("healthChecks.settings.detail", {
              value: settingsReadableId,
            })
          : t("healthChecks.settings.missing"),
    },
  ];
}
