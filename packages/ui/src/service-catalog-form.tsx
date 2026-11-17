"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { createUiClient } from "@masarx/api";
import { Button } from "./button";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { Input } from "./input";
import { Select } from "./select";
import { useToast } from "./use-toast";
import { formatUiError } from "./utils";

export type ServiceCatalogLevel = {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  isActive: boolean;
};

export type ServiceCatalogOffering = {
  id: string;
  displayName: string;
  serviceLevelName: string;
  branchName: string;
  zoneName?: string | null;
  isAvailable: boolean;
};

export type ServiceCatalogLocation = {
  id: string;
  name: string;
};

export type ServiceCatalogZone = ServiceCatalogLocation & {
  branchId: string;
};

type ServiceCatalogFormProps = {
  organizationId?: string | null;
  capabilities?: string[] | null;
  capabilityWrite?: string | null;
  levels: ServiceCatalogLevel[];
  offerings: ServiceCatalogOffering[];
  branches: ServiceCatalogLocation[];
  zones: ServiceCatalogZone[];
};

function keyFromName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function ServiceCatalogForm({
  organizationId,
  capabilities,
  capabilityWrite,
  levels,
  offerings,
  branches,
  zones,
}: ServiceCatalogFormProps) {
  const router = useRouter();
  const { toast } = useToast();
  const capabilitySet = React.useMemo(
    () => resolveCapabilitySet(capabilities ?? []),
    [capabilities]
  );
  const canWrite = Boolean(
    capabilityWrite?.trim() && hasCapability(capabilitySet, capabilityWrite.trim())
  );

  const [levelName, setLevelName] = React.useState("");
  const [levelKey, setLevelKey] = React.useState("");
  const [levelDescription, setLevelDescription] = React.useState("");
  const [offeringLevelId, setOfferingLevelId] = React.useState("");
  const [branchId, setBranchId] = React.useState("");
  const [zoneId, setZoneId] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [priority, setPriority] = React.useState("0");
  const [pending, setPending] = React.useState<"level" | "offering" | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const branchZones = zones.filter((zone) => zone.branchId === branchId);

  const createLevel = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrorMessage(null);
    const resolvedKey = levelKey.trim() || keyFromName(levelName);
    if (!organizationId || !levelName.trim() || !resolvedKey) {
      setErrorMessage("Organization, level name, and level key are required.");
      return;
    }
    if (!canWrite) {
      setErrorMessage("You do not have permission to manage the service catalog.");
      return;
    }

    setPending("level");
    try {
      await createUiClient().createServiceLevel({
        organizationId,
        key: resolvedKey,
        name: levelName.trim(),
        description: levelDescription.trim() || null,
      });
      setLevelName("");
      setLevelKey("");
      setLevelDescription("");
      toast({ tone: "success", title: "Service level created" });
      router.refresh();
    } catch (error) {
      const message = formatUiError(error, "Service level create failed.");
      setErrorMessage(message);
      toast({ tone: "error", title: "Service level create failed", description: message });
    } finally {
      setPending(null);
    }
  };

  const createOffering = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrorMessage(null);
    const resolvedPriority = Number(priority);
    if (!organizationId || !offeringLevelId || !branchId || !displayName.trim()) {
      setErrorMessage("Organization, service level, branch, and display name are required.");
      return;
    }
    if (!Number.isInteger(resolvedPriority) || resolvedPriority < 0) {
      setErrorMessage("Priority must be a non-negative whole number.");
      return;
    }
    if (!canWrite) {
      setErrorMessage("You do not have permission to manage the service catalog.");
      return;
    }

    setPending("offering");
    try {
      await createUiClient().createServiceOffering({
        organizationId,
        serviceLevelId: offeringLevelId,
        branchId,
        zoneId: zoneId || null,
        priority: resolvedPriority,
        metadata: { display: { name: displayName.trim() } },
      });
      setOfferingLevelId("");
      setBranchId("");
      setZoneId("");
      setDisplayName("");
      setPriority("0");
      toast({ tone: "success", title: "Service offering created" });
      router.refresh();
    } catch (error) {
      const message = formatUiError(error, "Service offering create failed.");
      setErrorMessage(message);
      toast({ tone: "error", title: "Service offering create failed", description: message });
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-6" data-testid="service-catalog-form">
      {!canWrite ? (
        <div className="rounded-2xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted">
          You can review this catalog, but your current role cannot change it.
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-2">
        <form className="space-y-4 rounded-2xl border border-ui-border p-4" onSubmit={createLevel}>
          <h3 className="text-base font-semibold text-ui-ink">Add service level</h3>
          <Input
            value={levelName}
            onChange={(event) => setLevelName(event.target.value)}
            placeholder="Level name"
            disabled={pending !== null}
            data-testid="service-catalog-level-name"
          />
          <Input
            value={levelKey}
            onChange={(event) => setLevelKey(event.target.value)}
            placeholder="Stable key (derived from name when blank)"
            disabled={pending !== null}
            data-testid="service-catalog-level-key"
          />
          <Input
            value={levelDescription}
            onChange={(event) => setLevelDescription(event.target.value)}
            placeholder="Optional description"
            disabled={pending !== null}
            data-testid="service-catalog-level-description"
          />
          <Button type="submit" disabled={pending !== null || !canWrite} data-testid="service-catalog-level-submit">
            {pending === "level" ? "Creating..." : "Create level"}
          </Button>
        </form>

        <form className="space-y-4 rounded-2xl border border-ui-border p-4" onSubmit={createOffering}>
          <h3 className="text-base font-semibold text-ui-ink">Add service offering</h3>
          <Select
            value={offeringLevelId}
            onChange={(event) => setOfferingLevelId(event.target.value)}
            disabled={pending !== null}
            data-testid="service-catalog-offering-level"
          >
            <option value="">Select service level</option>
            {levels.filter((level) => level.isActive).map((level) => (
              <option key={level.id} value={level.id}>{level.name} ({level.key})</option>
            ))}
          </Select>
          <Select
            value={branchId}
            onChange={(event) => {
              const nextBranchId = event.target.value;
              setBranchId(nextBranchId);
              if (!zones.some((zone) => zone.id === zoneId && zone.branchId === nextBranchId)) {
                setZoneId("");
              }
            }}
            disabled={pending !== null}
            data-testid="service-catalog-offering-branch"
          >
            <option value="">Select branch</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>{branch.name}</option>
            ))}
          </Select>
          <Select
            value={zoneId}
            onChange={(event) => setZoneId(event.target.value)}
            disabled={pending !== null || !branchId}
            data-testid="service-catalog-offering-zone"
          >
            <option value="">All branch zones</option>
            {branchZones.map((zone) => (
              <option key={zone.id} value={zone.id}>{zone.name}</option>
            ))}
          </Select>
          <Input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Display name"
            disabled={pending !== null}
            data-testid="service-catalog-offering-name"
          />
          <Input
            type="number"
            min="0"
            step="1"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            placeholder="Priority"
            disabled={pending !== null}
            data-testid="service-catalog-offering-priority"
          />
          <Button type="submit" disabled={pending !== null || !canWrite} data-testid="service-catalog-offering-submit">
            {pending === "offering" ? "Creating..." : "Create offering"}
          </Button>
        </form>
      </div>

      {errorMessage ? (
        <div className="rounded-2xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted" data-testid="service-catalog-error">
          {errorMessage}
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-base font-semibold text-ui-ink">Service levels</h3>
          {levels.map((level) => (
            <div key={level.id} className="rounded-xl border border-ui-border p-3 text-sm">
              <div className="font-medium text-ui-ink">{level.name}</div>
              <div className="text-ui-muted">{level.key}{level.description ? ` - ${level.description}` : ""}</div>
            </div>
          ))}
          {!levels.length ? <div className="text-sm text-ui-muted">No service levels configured.</div> : null}
        </div>
        <div className="space-y-2">
          <h3 className="text-base font-semibold text-ui-ink">Service offerings</h3>
          {offerings.map((offering) => (
            <div key={offering.id} className="rounded-xl border border-ui-border p-3 text-sm">
              <div className="font-medium text-ui-ink">{offering.displayName}</div>
              <div className="text-ui-muted">
                {offering.serviceLevelName} - {offering.branchName}
                {offering.zoneName ? ` - ${offering.zoneName}` : ""}
                {offering.isAvailable ? "" : " - unavailable"}
              </div>
            </div>
          ))}
          {!offerings.length ? <div className="text-sm text-ui-muted">No service offerings configured.</div> : null}
        </div>
      </div>
    </div>
  );
}
