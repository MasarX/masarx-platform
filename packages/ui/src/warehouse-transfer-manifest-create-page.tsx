import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { WarehouseTransferManifestCreateForm } from "./warehouse-transfer-manifest-create-form";
import { findRegistryResource } from "./ui-registry-utils";
import { createUiTranslator } from "./i18n";

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
  const t = createUiTranslator("ui.transferManifestCreate.page");

  return (
    <div className="space-y-6" data-testid={`${resolvedTestIdPrefix}-ready`}>
      <PageHeader
        title={t("title")}
        description={t("description")}
      />
      <Section
        title={t("sectionTitle")}
        description={t("sectionDescription")}
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
