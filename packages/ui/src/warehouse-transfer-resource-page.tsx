import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import { Button } from "./button";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { ResourcePage } from "./resource-page";
import { findRegistryResource } from "./ui-registry-utils";

type WarehouseTransferResourcePageProps = {
  appKey: "console" | "portal";
  appBasePath: string;
  searchParams: Record<string, string | string[] | undefined>;
  testIdPrefix: string;
};

export async function WarehouseTransferResourcePage({
  appKey,
  appBasePath,
  searchParams,
  testIdPrefix,
}: WarehouseTransferResourcePageProps) {
  const ui = createUiServerClient();
  const [meResult, registryResult] = await Promise.allSettled([ui.me(), ui.readRegistry()]);
  const me = meResult.status === "fulfilled" ? meResult.value : null;
  const registry = registryResult.status === "fulfilled" ? registryResult.value : null;
  const transfersResource = findRegistryResource(registry, "warehouse_transfers");
  const capabilitySet = resolveCapabilitySet(me?.capabilities ?? []);
  const canCreate =
    Boolean(me?.org?.id) &&
    Boolean(transfersResource?.capability_write) &&
    hasCapability(capabilitySet, transfersResource?.capability_write ?? null);

  const headerActions = canCreate ? (
    <Button asChild size="sm">
      <a
        href={`${appBasePath}/resources/warehouse_transfers/new?return_to=${encodeURIComponent(`${appBasePath}/resources/warehouse_transfers`)}`}
        data-testid={`${testIdPrefix}-create-action`}
      >
        Create transfer manifest
      </a>
    </Button>
  ) : null;

  return (
    <ResourcePage
      appKey={appKey}
      resourceKey="warehouse_transfers"
      searchParams={searchParams}
      appBasePath={appBasePath}
      testIdPrefix={testIdPrefix}
      headerActions={headerActions}
    />
  );
}
