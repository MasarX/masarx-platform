import { createUiServerClient } from "@masarx/api/server";
import type { IntegrationHealthEntry } from "@masarx/ui/client";
import {
  DEFAULT_INTEGRATION_SURFACE,
  FALLBACK_PROVIDER_SURFACE_MAP,
  resolveHealthStatusToneSync,
  resolveProviderSurfaceMap,
} from "../../../../../packages/ui/src/lookup-metadata";
import { DETAIL_PAGE_SIZE } from "../../../../../packages/ui/src/pagination-defaults";
import { IntegrationHealthPage } from "../../_components/integration-health-page";
import { withConsoleConfig } from "../../app-context";

export default withConsoleConfig(async () => {
  let integrations: IntegrationHealthEntry[] = [];
  try {
    const ui = createUiServerClient();
    const [surfaces, result] = await Promise.all([
      resolveProviderSurfaceMap(ui),
      ui.listResource("providers", {}, DETAIL_PAGE_SIZE, 0),
    ]);
    integrations = result.items.flatMap<IntegrationHealthEntry>((row) => {
      const id = typeof row.id === "string" ? row.id.trim() : "";
      const name = typeof row.name === "string" ? row.name.trim() : "";
      if (!id || !name) return [];
      const providerType = typeof row.provider_type === "string" ? row.provider_type.trim() : "";
      const surface = surfaces.get(providerType) ?? FALLBACK_PROVIDER_SURFACE_MAP.get(providerType);
      const tone = resolveHealthStatusToneSync(typeof row.health_status === "string" ? row.health_status : null);
      return [{
        id,
        name,
        type: surface === "api" || surface === "webhook" ? surface : DEFAULT_INTEGRATION_SURFACE,
        status: tone === "healthy" || tone === "down" ? tone : "degraded",
        lastCheckedAt: typeof row.updated_at === "string" ? row.updated_at : null,
      }];
    });
  } catch {
    // Keep provider read failures out of the rendered response.
  }
  return <IntegrationHealthPage integrations={integrations} />;
});
