import dynamic from "next/dynamic";
import { createServerClient } from "@masarx/auth";
import { createUiServerClient } from "@masarx/api/server";
import { LoadingState, hasCapability, resolveCapabilitySet } from "@masarx/ui";
import { notFound } from "next/navigation";
import { withConsoleConfig } from "../../../app-context";

const MappingStudioPage = dynamic(
  () => import("@masarx/ui").then((mod) => ({ default: mod.MappingStudioPage })),
  { loading: () => <LoadingState variant="page" /> }
);

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

const firstValue = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export default withConsoleConfig<PageProps>(async ({ appBasePath }, { searchParams }) => {
  const auth = createServerClient({ allowCookieSet: false });
  const {
    data: { session },
  } = await auth.auth.getSession();

  if (session) {
    const ui = createUiServerClient();
    const me = await ui.me().catch(() => null);
    const capabilities = Array.isArray(me?.capabilities) ? me.capabilities : [];
    if (!hasCapability(resolveCapabilitySet(capabilities), "integration_plugins.write")) {
      notFound();
    }
  }

  return (
    <MappingStudioPage
      appBasePath={appBasePath}
      initialArtifact="integration_plugin"
      initialContext={{
        targetResourceKey: firstValue(searchParams.resource) ?? null,
        webhookSourceId: firstValue(searchParams.webhook_source_id) ?? null,
        operationTemplateId: firstValue(searchParams.operation_template_id) ?? null,
        apiRouteId: firstValue(searchParams.api_route_id) ?? null,
        pluginId: firstValue(searchParams.plugin_id) ?? null,
        workflowTemplateId: firstValue(searchParams.workflow_template_id) ?? null,
      }}
      testIdPrefix="console-integration-plugin-studio"
    />
  );
});
