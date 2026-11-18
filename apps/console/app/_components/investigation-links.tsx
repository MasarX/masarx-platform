import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { createUiServerClient } from "@masarx/api/server";
import { hasCapability, resolveCapabilitySet } from "@masarx/ui";

export async function InvestigationLinks({ detail, appBasePath }: {
  detail: Record<string, unknown>; appBasePath: string;
}) {
  let capabilities;
  try {
    capabilities = resolveCapabilitySet((await createUiServerClient().me()).capabilities ?? []);
  } catch {
    return null;
  }
  const t = await getTranslations("ui.investigation");
  const correlationId = typeof detail.correlation_id === "string" ? detail.correlation_id.trim() : "";
  const resolutionId = typeof detail.settings_resolution_id === "string" ? detail.settings_resolution_id.trim() : "";
  return <div className="flex flex-wrap gap-4 text-sm">
    {correlationId && hasCapability(capabilities, "audit_log.read") ?
      <Link href={`${appBasePath}/observability/trace/${encodeURIComponent(correlationId)}`}>
        {t("trace", { id: correlationId })}
      </Link> : null}
    {resolutionId && hasCapability(capabilities, "settings.read") ?
      <Link href={`${appBasePath}/resources/settings_resolution_log?id=${encodeURIComponent(resolutionId)}&detail_open=1`}>
        {t("policy", { id: resolutionId })}
      </Link> : null}
  </div>;
}
