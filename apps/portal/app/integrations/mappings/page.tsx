import { Button, PageHeader, Section } from "@masarx/ui";
import { withPortalConfig } from "../../app-context";

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

const STUDIO_QUERY_KEYS = [
  "artifact",
  "resource",
  "webhook_source_id",
  "operation_template_id",
  "api_route_id",
  "plugin_id",
  "workflow_template_id",
];

const firstValue = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

function buildStudioHref(
  appBasePath: string,
  searchParams: PageProps["searchParams"],
) {
  const params = new URLSearchParams();

  for (const key of STUDIO_QUERY_KEYS) {
    const value = firstValue(searchParams[key]);
    if (value) {
      params.set(key, value);
    }
  }

  const query = params.toString();
  return query
    ? `${appBasePath}/integrations/mappings/new?${query}`
    : `${appBasePath}/integrations/mappings/new`;
}

export function PortalMappingsPage({
  appBasePath,
  searchParams,
}: {
  appBasePath: string;
  searchParams: PageProps["searchParams"];
}) {
  const studioHref = buildStudioHref(appBasePath, searchParams);
  const reportIndexHref = `${appBasePath}/resources/mapping_operation_reports`;

  return (
    <div className="space-y-6" data-testid="portal-mappings-ready">
      <PageHeader
        title="Mapping Studio"
        description="Portal entrypoint for provider onboarding mapping drafts and persisted operation reports."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          title="Start a new mapping draft"
          description="Open the guided studio when you need to parse source contracts, infer mappings, and submit a governed draft."
        >
          <div className="space-y-3">
            <p className="text-sm text-ui-muted">
              The studio supports runtime mappings, tabular imports, webhook inbound flows, API outbound flows, and integration plugin drafts.
            </p>
            <Button asChild size="sm" variant="ghost">
              <a href={`${appBasePath}/onboarding/readiness`}>Onboarding readiness</a>
            </Button>
            <Button asChild size="sm">
              <a href={studioHref}>Start new mapping draft</a>
            </Button>
          </div>
        </Section>

        <Section
          title="Review operation reports"
          description="Reopen completed submits and inspect the persisted operation report that the studio exposes after save."
        >
          <div className="space-y-3">
            <p className="text-sm text-ui-muted">
              Saved reports stay visible from the studio result panel and can also be reopened from the canonical report index.
            </p>
            <Button asChild size="sm" variant="ghost">
              <a href={reportIndexHref}>Open report index</a>
            </Button>
          </div>
        </Section>
      </div>
    </div>
  );
}

export default withPortalConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <PortalMappingsPage appBasePath={appBasePath} searchParams={searchParams} />
));
