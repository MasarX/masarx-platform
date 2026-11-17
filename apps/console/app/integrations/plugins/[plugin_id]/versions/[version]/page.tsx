import { ResourcePage } from "../../../../../_components/resource-page";
import { withConsoleConfig } from "../../../../../app-context";

type PageProps = {
  params: { plugin_id: string; version: string };
  searchParams: Record<string, string | string[] | undefined>;
};

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export default withConsoleConfig<PageProps>(({ appKey, appBasePath }, { params, searchParams }) => {
  const versionToken = params.version;
  const mergedSearchParams: Record<string, string | string[] | undefined> = {
    ...searchParams,
    plugin_id: params.plugin_id,
  };

  if (isUuid(versionToken)) {
    mergedSearchParams.id = versionToken;
  } else {
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
          </div>
        );
      }}
    />
  );
});
