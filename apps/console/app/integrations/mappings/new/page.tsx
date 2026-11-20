import dynamic from "next/dynamic";
import { LoadingState } from "@masarx/ui/client";
import { withConsoleConfig } from "../../../app-context";
import { resolveMappingArtifact } from "../../../../../shared/mapping-studio";

const MappingStudioPage = dynamic(
  () => import("@masarx/ui/client").then((mod) => ({ default: mod.MappingStudioPage })),
  { loading: () => <LoadingState variant="page" /> }
);

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

const firstValue = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export default withConsoleConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <MappingStudioPage
    appBasePath={appBasePath}
    initialArtifact={resolveMappingArtifact(firstValue(searchParams.artifact))}
    initialContext={{
      targetResourceKey: firstValue(searchParams.resource) ?? null,
      webhookSourceId: firstValue(searchParams.webhook_source_id) ?? null,
      operationTemplateId: firstValue(searchParams.operation_template_id) ?? null,
      apiRouteId: firstValue(searchParams.api_route_id) ?? null,
      pluginId: firstValue(searchParams.plugin_id) ?? null,
      workflowTemplateId: firstValue(searchParams.workflow_template_id) ?? null,
    }}
    testIdPrefix="console-mapping-studio"
  />
));
