import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import {
  ShipmentManualCreateForm,
  type ShipmentServiceOfferingOption,
} from "./shipment-manual-create-form";
import { findRegistryResource } from "./ui-registry-utils";

type ShipmentManualCreatePageProps = {
  appBasePath: string;
  requirePersistedReadback?: boolean;
  returnTo?: string | null;
  testIdPrefix?: string | null;
};

export async function ShipmentManualCreatePage({
  appBasePath,
  requirePersistedReadback,
  returnTo,
  testIdPrefix,
}: ShipmentManualCreatePageProps) {
  const ui = createUiServerClient();
  const [meResult, registryResult, offeringsResult] = await Promise.allSettled([
    ui.me(),
    ui.readRegistry(),
    ui.listResource(
      "service_offering_directory",
      { is_available: true },
      200,
      0,
      { key: "display_name", direction: "asc" }
    ),
  ]);
  const me = meResult.status === "fulfilled" ? meResult.value : null;
  const registry = registryResult.status === "fulfilled" ? registryResult.value : null;
  const shipmentsResource = findRegistryResource(registry, "shipments");
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "shipment-manual-create";
  const serviceOfferings: ShipmentServiceOfferingOption[] =
    offeringsResult.status === "fulfilled"
      ? offeringsResult.value.items.flatMap((item) => {
          const id = String(item.id ?? "").trim();
          const displayName = String(item.display_name ?? "").trim();
          const serviceLevelKey = String(item.service_level_key ?? "").trim();
          return id && displayName && serviceLevelKey
            ? [{ id, displayName, serviceLevelKey }]
            : [];
        })
      : [];

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
          requirePersistedReadback={requirePersistedReadback}
          returnTo={returnTo}
          organizationId={me?.org?.id ?? null}
          organizationName={me?.org?.name ?? null}
          scopeOptions={registry?.scopes ?? null}
          accessScope={me?.access_scope ?? null}
          capabilities={me?.capabilities ?? null}
          capabilityWrite={shipmentsResource?.capability_write ?? null}
          testIdPrefix={resolvedTestIdPrefix}
          serviceOfferings={serviceOfferings}
        />
      </Section>
    </div>
  );
}
