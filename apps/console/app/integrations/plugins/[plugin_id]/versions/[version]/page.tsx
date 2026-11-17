import { createUiServerClient } from "@masarx/api/server";
import { ResourcePage } from "../../../../../_components/resource-page";
import { withConsoleConfig } from "../../../../../app-context";
import { MarketplacePublishLink } from "../../../../../automation/marketplace/_components/marketplace-page";

type PageProps = {
  params: { plugin_id: string; version: string };
  searchParams: Record<string, string | string[] | undefined>;
};

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const MISSING_DETAIL_ID = "00000000-0000-4000-8000-000000000000";

const isVersionNumber = (value: string): boolean => /^\d+$/.test(value.trim());

const firstSearchParam = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) return value[0];
  return value;
};

async function resolveVersionDetailId(pluginId: string, versionToken: string): Promise<string> {
  if (isUuid(versionToken)) {
    return versionToken;
  }

  if (!isVersionNumber(versionToken)) {
    return MISSING_DETAIL_ID;
  }

  try {
    const ui = createUiServerClient();
    const list = await ui.listResource(
      "integration_plugin_versions",
      {
        plugin_id: pluginId,
        version_no: Number(versionToken),
      },
      2,
      0,
      null,
    );
    const items = Array.isArray(list?.items) ? list.items : [];
    const match = items.find((entry) => entry && typeof entry.id === "string");
    return typeof match?.id === "string" ? match.id : MISSING_DETAIL_ID;
  } catch {
    return MISSING_DETAIL_ID;
  }
}

export default withConsoleConfig<PageProps>(async ({ appKey, appBasePath }, { params, searchParams }) => {
  const versionToken = params.version;
  const detailId = await resolveVersionDetailId(params.plugin_id, versionToken);
  const mergedSearchParams: Record<string, string | string[] | undefined> = {
    ...searchParams,
    plugin_id: params.plugin_id,
    id: detailId,
    detail_open: firstSearchParam(searchParams.detail_open) ?? "1",
  };

  if (!isUuid(versionToken) && isVersionNumber(versionToken)) {
    mergedSearchParams.version_no = versionToken;
  }

  return (
    <ResourcePage
      appKey={appKey}
      resourceKey="integration_plugin_versions"
      searchParams={mergedSearchParams}
      appBasePath={appBasePath}
      baseHref={`${appBasePath}/integrations/plugins/${encodeURIComponent(params.plugin_id)}/versions/${encodeURIComponent(versionToken)}`}
      testIdPrefix="console-integration-plugin-version"
      renderDetailFooter={({ detailId, detailError }) => {
        if (!detailId || detailError) return null;
        return (
          <div className="pt-3" data-testid="console-integration-plugin-version-links">
            <a
              className="text-sm text-ui-ink underline underline-offset-4"
              href={`${appBasePath}/resources/integration_plugin_validation_runs?plugin_version_id=${encodeURIComponent(detailId)}`}
              data-testid="console-integration-plugin-version-open-validations"
            >
              Open Validation Runs
            </a>
            <a
              className="ml-3 text-sm text-ui-ink underline underline-offset-4"
              href={`${appBasePath}/resources/integration_plugin_approval_events?plugin_version_id=${encodeURIComponent(detailId)}`}
              data-testid="console-integration-plugin-version-open-approvals"
            >
              Open Approval Events
            </a>
            <MarketplacePublishLink appBasePath={appBasePath} assetKind="integration_plugin" sourceId={detailId} />
          </div>
        );
      }}
    />
  );
});
