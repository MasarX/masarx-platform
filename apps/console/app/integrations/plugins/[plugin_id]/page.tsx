import { ResourcePage } from "../../../_components/resource-page";
import { withConsoleConfig } from "../../../app-context";
import { MarketplacePublishLink } from "../../../automation/marketplace/_components/marketplace-page";

type PageProps = {
  params: { plugin_id: string };
  searchParams: Record<string, string | string[] | undefined>;
};

export default withConsoleConfig<PageProps>(({ appKey, appBasePath }, { params, searchParams }) => {
  const mergedSearchParams = {
    ...searchParams,
    id: params.plugin_id,
  };

  return (
    <ResourcePage
      appKey={appKey}
      resourceKey="integration_plugins"
      searchParams={mergedSearchParams}
      appBasePath={appBasePath}
      baseHref={`${appBasePath}/integrations/plugins/${encodeURIComponent(params.plugin_id)}`}
      testIdPrefix="console-integration-plugin-detail"
      renderDetailFooter={({ detailId, detailError, detail }) => {
        if (!detailId || detailError) return null;
        const activeVersionId = typeof detail?.active_version_id === "string" ? detail.active_version_id : "";

        return (
          <div className="pt-3" data-testid="console-integration-plugin-detail-links">
            <a
              className="text-sm text-ui-ink underline underline-offset-4"
              href={`${appBasePath}/resources/integration_plugin_versions?plugin_id=${encodeURIComponent(detailId)}`}
              data-testid="console-integration-plugin-open-versions"
            >
              Open All Versions
            </a>
            {activeVersionId ? (
              <a
                className="ml-3 text-sm text-ui-ink underline underline-offset-4"
                href={`${appBasePath}/integrations/plugins/${encodeURIComponent(detailId)}/versions/${encodeURIComponent(activeVersionId)}`}
                data-testid="console-integration-plugin-open-active-version"
              >
                Open Active Version
              </a>
            ) : null}
            {activeVersionId ? <MarketplacePublishLink appBasePath={appBasePath} assetKind="integration_plugin" sourceId={activeVersionId} /> : null}
          </div>
        );
      }}
    />
  );
});
