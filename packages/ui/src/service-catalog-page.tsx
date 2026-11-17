import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import {
  ServiceCatalogForm,
  type ServiceCatalogLevel,
  type ServiceCatalogLocation,
  type ServiceCatalogOffering,
  type ServiceCatalogZone,
} from "./service-catalog-form";
import { findRegistryResource } from "./ui-registry-utils";

function text(value: unknown) {
  return String(value ?? "").trim();
}

function locations(items: Record<string, unknown>[]): ServiceCatalogLocation[] {
  return items.flatMap((item) => {
    const id = text(item.id);
    const name = text(item.name);
    return id && name ? [{ id, name }] : [];
  });
}

function branchZones(items: Record<string, unknown>[]): ServiceCatalogZone[] {
  return items.flatMap((item) => {
    const id = text(item.id);
    const name = text(item.name);
    const branchId = text(item.branch_id);
    return id && name && branchId ? [{ id, name, branchId }] : [];
  });
}

type ServiceCatalogPageProps = {
  testIdPrefix: string;
};

export async function ServiceCatalogPage({ testIdPrefix }: ServiceCatalogPageProps) {
  const ui = createUiServerClient();
  const [meResult, registryResult, levelsResult, offeringsResult, branchesResult, zonesResult] =
    await Promise.allSettled([
      ui.me(),
      ui.readRegistry(),
      ui.listResource("service_level_directory", {}, 200, 0, { key: "name", direction: "asc" }),
      ui.listResource("service_offering_directory", {}, 200, 0, { key: "priority", direction: "desc" }),
      ui.listResource("service_branch_directory", { is_active: true }, 200, 0, { key: "name", direction: "asc" }),
      ui.listResource("service_branch_zone_directory", {}, 500, 0, { key: "name", direction: "asc" }),
    ]);

  const failedReads = [
    { label: "profile", result: meResult },
    { label: "registry", result: registryResult },
    { label: "service levels", result: levelsResult },
    { label: "service offerings", result: offeringsResult },
    { label: "branches", result: branchesResult },
    { label: "branch zones", result: zonesResult },
  ].filter(({ result }) => result.status === "rejected").map(({ label }) => label);

  if (failedReads.length > 0) {
    return (
      <div className="space-y-6" data-testid={`${testIdPrefix}-error`}>
        <PageHeader
          title="Service catalog"
          description="Manage tenant service levels and branch or zone offerings from the canonical catalog."
        />
        <Section title="Catalog unavailable" collapsible={false}>
          <p role="alert" className="text-sm text-ui-danger">
            Service catalog data could not be loaded. Try again or contact support if the problem continues.
          </p>
          <p className="text-xs text-ui-muted">
            Failed reads: {failedReads.join(", ")}.
          </p>
        </Section>
      </div>
    );
  }

  const me = meResult.status === "fulfilled" ? meResult.value : null;
  const registry = registryResult.status === "fulfilled" ? registryResult.value : null;
  const resource = findRegistryResource(registry, "service_offering_directory");

  const levels: ServiceCatalogLevel[] = levelsResult.status === "fulfilled"
    ? levelsResult.value.items.flatMap((item) => {
        const id = text(item.id);
        const key = text(item.key);
        const name = text(item.name);
        return id && key && name ? [{
          id,
          key,
          name,
          description: text(item.description) || null,
          isActive: item.is_active === true,
        }] : [];
      })
    : [];

  const offerings: ServiceCatalogOffering[] = offeringsResult.status === "fulfilled"
    ? offeringsResult.value.items.flatMap((item) => {
        const id = text(item.id);
        const displayName = text(item.display_name);
        const serviceLevelName = text(item.service_level_name);
        const branchName = text(item.branch_name);
        return id && displayName && serviceLevelName && branchName ? [{
          id,
          displayName,
          serviceLevelName,
          branchName,
          zoneName: text(item.zone_name) || null,
          isAvailable: item.is_available === true,
        }] : [];
      })
    : [];

  return (
    <div className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
      <PageHeader
        title="Service catalog"
        description="Manage tenant service levels and branch or zone offerings from the canonical catalog."
      />
      <Section
        title="Product context"
        description="Shipment creation validates the selected active offering and derives its service-level, branch, and zone lineage on the workflow write."
        collapsible={false}
      >
        <ServiceCatalogForm
          organizationId={me?.org?.id ?? null}
          capabilities={me?.capabilities ?? null}
          capabilityWrite={resource?.capability_write ?? null}
          levels={levels}
          offerings={offerings}
          branches={branchesResult.status === "fulfilled" ? locations(branchesResult.value.items) : []}
          zones={zonesResult.status === "fulfilled" ? branchZones(zonesResult.value.items) : []}
        />
      </Section>
    </div>
  );
}
