import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { WarehouseTransferManifestCreateForm } from "./warehouse-transfer-manifest-create-form";
import { findRegistryResource } from "./ui-registry-utils";

type WarehouseTransferManifestCreatePageProps = {
  appBasePath: string;
  returnTo?: string | null;
  testIdPrefix?: string | null;
};

export async function WarehouseTransferManifestCreatePage({
  appBasePath,
  returnTo,
  testIdPrefix,
}: WarehouseTransferManifestCreatePageProps) {
  const ui = createUiServerClient();
  const [meResult, registryResult] = await Promise.allSettled([ui.me(), ui.readRegistry()]);
  const me = meResult.status === "fulfilled" ? meResult.value : null;
  const registry = registryResult.status === "fulfilled" ? registryResult.value : null;
  const transfersResource = findRegistryResource(registry, "warehouse_transfers");
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "warehouse-transfer-manifest-create";

  return (
    <div className="space-y-6" data-testid={`${resolvedTestIdPrefix}-ready`}>
      <PageHeader
        title="Create transfer manifest"
        description="Create draft warehouse transfer manifests through the canonical transfer-manifest contract."
      />
      <Section
        title="Manifest details"
        description="A manifest creates the draft warehouse_transfers row and its warehouse_transfer_items membership in one authoritative step."
        collapsible={false}
      >
        <WarehouseTransferManifestCreateForm
          appBasePath={appBasePath}
          returnTo={returnTo}
          organizationId={me?.org?.id ?? null}
          accessScope={me?.access_scope ?? null}
          capabilities={me?.capabilities ?? null}
          capabilityWrite={transfersResource?.capability_write ?? null}
          testIdPrefix={resolvedTestIdPrefix}
        />
      </Section>
    </div>
  );
}
