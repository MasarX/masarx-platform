import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { ShipmentManualCreateForm } from "./shipment-manual-create-form";
import { findRegistryResource } from "./ui-registry-utils";

type ShipmentManualCreatePageProps = {
  appBasePath: string;
  returnTo?: string | null;
  testIdPrefix?: string | null;
};

export async function ShipmentManualCreatePage({
  appBasePath,
  returnTo,
  testIdPrefix,
}: ShipmentManualCreatePageProps) {
  const ui = createUiServerClient();
  const [meResult, registryResult] = await Promise.allSettled([ui.me(), ui.readRegistry()]);
  const me = meResult.status === "fulfilled" ? meResult.value : null;
  const registry = registryResult.status === "fulfilled" ? registryResult.value : null;
  const shipmentsResource = findRegistryResource(registry, "shipments");
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "shipment-manual-create";

  return (
    <div className="space-y-6" data-testid={`${resolvedTestIdPrefix}-ready`}>
      <PageHeader
        title="Create shipment"
        description="Create shipments from Console or Portal through the authoritative reserve/create workflow path."
      />
      <Section
        title="Shipment details"
        description="Manual create resolves scope at submit time, reserves tracking when omitted, and reuses existing shipments when duplicate keys match."
        collapsible={false}
      >
        <ShipmentManualCreateForm
          appBasePath={appBasePath}
          returnTo={returnTo}
          organizationId={me?.org?.id ?? null}
          accessScope={me?.access_scope ?? null}
          capabilities={me?.capabilities ?? null}
          capabilityWrite={shipmentsResource?.capability_write ?? null}
          testIdPrefix={resolvedTestIdPrefix}
        />
      </Section>
    </div>
  );
}
