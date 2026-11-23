"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  createUiClient,
  isRetriableNetworkError,
  isRetriableSupabaseError,
  type UiScope,
} from "@masarx/api";
import { Button } from "./button";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { RelationField } from "./relation-field";
import { formatReferenceValue } from "./resource-utils";
import { useToast } from "./use-toast";
import { formatUiError } from "./utils";
import { isTimeoutError, resolveUiRpcTimeoutMs, withTimeout } from "./promise-timeout";
import { useUnsavedChangesGuard } from "./use-unsaved-changes";
import { resolveBaseOrigin, resolveSafeHref } from "./url-guard";

const INVALID_DISPATCH_TIME = "Enter a valid planned dispatch time.";
const INVALID_RECEIVE_TIME = "Enter a valid planned receive time.";
const RECEIVE_BEFORE_DISPATCH = "Planned receive time must be at or after planned dispatch time.";

type WarehouseTransferManifestCreateFormProps = {
  appBasePath: string;
  returnTo?: string | null;
  organizationId?: string | null;
  accessScope?: UiScope | null;
  capabilities?: string[] | null;
  capabilityWrite?: string | null;
  testIdPrefix?: string | null;
};

function normalizeReturnTo(value: string | null | undefined, fallback: string) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return fallback;
  const href = resolveSafeHref("", trimmed);
  return href && !href.startsWith("//") ? href : fallback;
}

function buildTransferDetailHref(returnTo: string, transferId: string) {
  const url = new URL(returnTo, resolveBaseOrigin());
  url.searchParams.set("id", transferId);
  url.searchParams.set("detail_open", "1");
  return `${url.pathname}${url.search}${url.hash}`;
}

function scopeLabel(scope: UiScope | null | undefined) {
  const scopeType = String(scope?.scope_type ?? "").trim().toLowerCase();
  if (scopeType === "tenant") return "Tenant scope";
  if (scopeType === "platform") return "Platform scope";
  if (scopeType === "client") return "Client scope";
  if (scopeType === "sender") return "Sender scope";
  return "Scoped session";
}

function parseShipmentIds(value: string) {
  const entries = value
    .split(/[\s,]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Array.from(new Set(entries));
}

type LookupOption = { value: string; label: string };

function mergeSelectedOptions(options: LookupOption[], previous: LookupOption[], selected: string[]) {
  return [...options, ...previous.filter((option) =>
    selected.includes(option.value) && !options.some(({ value }) => value === option.value)
  )];
}

function toLocalDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromLocalDateTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

async function fetchManifestOptions(resource: "branches" | "shipments", key: string, query: string, labelKeys: string[]) {
  const result = await createUiClient().listResource(resource, { [key]: query }, 25);
  return (result.items ?? []).flatMap((item) => {
    const value = typeof item.id === "string" ? item.id.trim() : "";
    if (!value) return [];
    const labels = labelKeys.map((field) => typeof item[field] === "string" ? String(item[field]).trim() : "")
      .filter((label) => label && label !== value);
    return [{ value, label: [...new Set(labels)].join(" | ") || formatReferenceValue(value) }];
  });
}

export function WarehouseTransferManifestCreateForm({
  appBasePath,
  returnTo,
  organizationId,
  accessScope,
  capabilities,
  capabilityWrite,
  testIdPrefix,
}: WarehouseTransferManifestCreateFormProps) {
  const router = useRouter();
  const { toast } = useToast();
  const scopeId = String(accessScope?.scope_id ?? "").trim();
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "warehouse-transfer-manifest-create";
  const transferListPath = "/resources/warehouse_transfers";
  const fallbackReturnTo = normalizeReturnTo(
    resolveSafeHref(appBasePath, transferListPath),
    transferListPath,
  );
  const normalizedReturnTo = React.useMemo(
    () => normalizeReturnTo(returnTo, fallbackReturnTo),
    [fallbackReturnTo, returnTo]
  );
  const resolvedCapabilityWrite = capabilityWrite?.trim() ?? "";
  const canCreate =
    resolvedCapabilityWrite.length > 0 &&
    hasCapability(resolveCapabilitySet(capabilities), resolvedCapabilityWrite);
  const canResolvePermissions = resolvedCapabilityWrite.length > 0;

  const [transferCode, setTransferCode] = React.useState("");
  const [fromBranchId, setFromBranchId] = React.useState("");
  const [toBranchId, setToBranchId] = React.useState("");
  const [plannedDispatchAt, setPlannedDispatchAt] = React.useState("");
  const [plannedReceiveAt, setPlannedReceiveAt] = React.useState("");
  const dispatchInputRef = React.useRef<HTMLInputElement>(null);
  const receiveInputRef = React.useRef<HTMLInputElement>(null);
  const errorId = React.useId();
  const [shipmentIdsText, setShipmentIdsText] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const shipmentIds = React.useMemo(() => parseShipmentIds(shipmentIdsText), [shipmentIdsText]);
  const [branchOptions, setBranchOptions] = React.useState<LookupOption[]>([]);
  const [shipmentOptions, setShipmentOptions] = React.useState<LookupOption[]>([]);
  const lookupEnabled = canCreate && Boolean(organizationId?.trim());

  const fetchBranches = React.useCallback(async (query: string) => {
    const options = await fetchManifestOptions("branches", "name", query, ["name", "code"]);
    setBranchOptions((previous) => mergeSelectedOptions(options, previous, [fromBranchId, toBranchId]));
    return options;
  }, [fromBranchId, toBranchId]);
  const fetchShipments = React.useCallback(async (query: string) => {
    const options = await fetchManifestOptions("shipments", "identifier", query, [
      "tracking_number", "client_reference_number", "carrier_reference_number",
    ]);
    setShipmentOptions((previous) => mergeSelectedOptions(options, previous, shipmentIds));
    return options;
  }, [shipmentIds]);
  const hasChanges = Boolean(
    transferCode.trim() ||
      fromBranchId.trim() ||
      toBranchId.trim() ||
      plannedDispatchAt.trim() ||
      plannedReceiveAt.trim() ||
      shipmentIdsText.trim()
  );

  useUnsavedChangesGuard({
    enabled: true,
    isSubmitting: pending,
    hasChanges,
    warningMessage: "You have an unsaved warehouse transfer manifest draft.",
  });

  const timeoutMs = React.useMemo(() => resolveUiRpcTimeoutMs(), []);
  const shouldRetry = React.useCallback((error: unknown) => {
    if (isTimeoutError(error)) return true;
    if (isRetriableSupabaseError(error)) return true;
    if (isRetriableNetworkError(error)) return true;
    return false;
  }, []);

  const delay = React.useCallback(
    (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, Math.max(0, ms));
      }),
    []
  );

  const handleSubmit = React.useCallback(async () => {
    if (pending) return;
    setErrorMessage(null);

    if (!organizationId?.trim()) {
      setErrorMessage("Warehouse transfer manifest create requires an organization-scoped session.");
      return;
    }
    if (!transferCode.trim()) {
      setErrorMessage("Transfer code is required.");
      return;
    }
    if (!fromBranchId.trim() || !toBranchId.trim()) {
      setErrorMessage("From branch ID and to branch ID are required.");
      return;
    }
    if (shipmentIds.length < 1) {
      setErrorMessage("At least one shipment ID is required.");
      return;
    }
    if (!canCreate) {
      setErrorMessage(
        canResolvePermissions
          ? "You do not have permission to create warehouse transfers."
          : "Warehouse transfer create permissions are unavailable."
      );
      return;
    }
    const dispatchTime = plannedDispatchAt.trim();
    const receiveTime = plannedReceiveAt.trim();
    const dispatchMillis = Date.parse(dispatchTime);
    const receiveMillis = Date.parse(receiveTime);
    if (dispatchTime && Number.isNaN(dispatchMillis)) {
      setErrorMessage(INVALID_DISPATCH_TIME);
      dispatchInputRef.current?.focus();
      return;
    }
    if ((receiveTime && Number.isNaN(receiveMillis)) || receiveMillis < dispatchMillis) {
      setErrorMessage(Number.isNaN(receiveMillis) ? INVALID_RECEIVE_TIME : RECEIVE_BEFORE_DISPATCH);
      receiveInputRef.current?.focus();
      return;
    }

    setPending(true);
    try {
      const ui = createUiClient();
      const payload = {
        organizationId: organizationId.trim(),
        transferCode: transferCode.trim(),
        fromBranchId: fromBranchId.trim(),
        toBranchId: toBranchId.trim(),
        shipmentIds,
        plannedDispatchAt: dispatchTime || null,
        plannedReceiveAt: receiveTime || null,
        metadata: {
          source: "ui.transfer_manifest_create",
          app_base_path: appBasePath,
          return_to: normalizedReturnTo,
        },
      };

      let result: Awaited<ReturnType<typeof ui.createWarehouseTransferManifest>> | null = null;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          result = await withTimeout(ui.createWarehouseTransferManifest(payload), timeoutMs);
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= 2 || !shouldRetry(error)) throw error;
          await delay(800);
        }
      }

      if (!result && lastError) throw lastError;

      const transferId = String(
        result?.transfer_id ?? result?.warehouse_transfer_id ?? ""
      ).trim();
      if (!transferId) {
        throw new Error("Warehouse transfer manifest create completed without returning transfer_id.");
      }

      toast({
        tone: "success",
        title:
          String(result?.operation ?? "").trim() === "inserted"
            ? "Transfer manifest created"
            : "Existing transfer manifest reused",
        description: transferCode.trim(),
      });
      router.push(buildTransferDetailHref(normalizedReturnTo, transferId));
    } catch (error) {
      const message = formatUiError(error, "Warehouse transfer manifest create failed.");
      setErrorMessage(message);
      toast({
        tone: "error",
        title: "Transfer manifest create failed",
        description: message,
      });
    } finally {
      setPending(false);
    }
  }, [
    appBasePath,
    canCreate,
    canResolvePermissions,
    delay,
    fromBranchId,
    normalizedReturnTo,
    organizationId,
    pending,
    plannedDispatchAt,
    plannedReceiveAt,
    router,
    shipmentIds,
    shouldRetry,
    timeoutMs,
    toast,
    toBranchId,
    transferCode,
  ]);

  return (
    <div className="space-y-6" data-testid={`${resolvedTestIdPrefix}-form`}>
      <div className="grid gap-3 rounded-2xl border border-ui-border bg-ui-surface/60 p-4 text-sm text-ui-muted md:grid-cols-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-ui-muted/70">Organization</div>
          <div data-testid={`${resolvedTestIdPrefix}-organization`}>
            {organizationId?.trim()
              ? accessScope?.scope_type === "tenant" && scopeId === organizationId.trim() && accessScope.scope_label?.trim()
                ? accessScope.scope_label
                : formatReferenceValue(organizationId.trim())
              : "Unavailable"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-ui-muted/70">Session scope</div>
          <div data-testid={`${resolvedTestIdPrefix}-scope`}>
            {accessScope?.scope_label?.trim() || scopeLabel(accessScope)}
            {scopeId && !accessScope?.scope_label?.trim() ? " - " + formatReferenceValue(scopeId) : ""}
          </div>
        </div>
      </div>

      {!canCreate ? (
        <div
          className="rounded-2xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted"
          data-testid={`${resolvedTestIdPrefix}-permissions`}
        >
          {canResolvePermissions
            ? "You do not have permission to create warehouse transfers from this surface."
            : "Warehouse transfer create permissions are unavailable for this session."}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">Transfer code</span>
          <Input
            value={transferCode}
            onChange={(event) => setTransferCode(event.target.value)}
            placeholder="XFER-20260404-001"
            disabled={pending}
            data-testid={`${resolvedTestIdPrefix}-transfer-code`}
          />
        </label>

        <div className="space-y-2 rounded-2xl border border-ui-border bg-ui-surface/60 px-4 py-3 text-sm text-ui-muted">
          <div className="text-xs uppercase tracking-wide text-ui-muted/70">Manifest size</div>
          <div data-testid={`${resolvedTestIdPrefix}-shipment-count`}>
            {shipmentIds.length} shipment{shipmentIds.length === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2" role="group" aria-labelledby={`${resolvedTestIdPrefix}-from-branch-label`}>
          <span id={`${resolvedTestIdPrefix}-from-branch-label`} className="text-sm text-ui-ink">From branch</span>
          <RelationField value={fromBranchId} onChange={(value) => setFromBranchId(String(value))}
            options={branchOptions.filter((item) => item.value === fromBranchId)} fetcher={lookupEnabled ? fetchBranches : undefined}
            placeholder="Search origin branches" disabled={pending || !lookupEnabled} />
        </div>
        <div className="space-y-2" role="group" aria-labelledby={`${resolvedTestIdPrefix}-to-branch-label`}>
          <span id={`${resolvedTestIdPrefix}-to-branch-label`} className="text-sm text-ui-ink">To branch</span>
          <RelationField value={toBranchId} onChange={(value) => setToBranchId(String(value))}
            options={branchOptions.filter((item) => item.value === toBranchId)} fetcher={lookupEnabled ? fetchBranches : undefined}
            placeholder="Search destination branches" disabled={pending || !lookupEnabled} />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2 text-sm text-ui-ink">
          <span>Planned dispatch time (local)</span>
          <Input ref={dispatchInputRef} type="datetime-local" value={toLocalDateTime(plannedDispatchAt)}
            invalid={errorMessage === INVALID_DISPATCH_TIME}
            aria-describedby={errorMessage === INVALID_DISPATCH_TIME ? errorId : undefined}
            onChange={(event) => setPlannedDispatchAt(fromLocalDateTime(event.target.value))} disabled={pending} />
        </label>
        <label className="space-y-2 text-sm text-ui-ink">
          <span>Planned receipt time (local)</span>
          <Input ref={receiveInputRef} type="datetime-local" value={toLocalDateTime(plannedReceiveAt)}
            invalid={errorMessage === INVALID_RECEIVE_TIME || errorMessage === RECEIVE_BEFORE_DISPATCH}
            aria-describedby={errorMessage === INVALID_RECEIVE_TIME || errorMessage === RECEIVE_BEFORE_DISPATCH ? errorId : undefined}
            onChange={(event) => setPlannedReceiveAt(fromLocalDateTime(event.target.value))} disabled={pending} />
        </label>
      </div>

      <div className="space-y-2" role="group" aria-labelledby={`${resolvedTestIdPrefix}-shipments-label`}>
        <span id={`${resolvedTestIdPrefix}-shipments-label`} className="text-sm text-ui-ink">Shipments</span>
        <RelationField mode="multi" value={shipmentIds}
          onChange={(value) => setShipmentIdsText(Array.isArray(value) ? value.join("\n") : value)}
          options={shipmentOptions.filter((item) => shipmentIds.includes(item.value))}
          fetcher={lookupEnabled ? fetchShipments : undefined}
          placeholder="Search shipment tracking or client reference" disabled={pending || !lookupEnabled} />
      </div>

      <details className="space-y-3">
        <summary className="text-sm text-ui-muted">Enter record IDs and timestamps</summary>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm text-ui-ink">
            <span className="text-xs uppercase tracking-wide text-ui-muted">From branch ID</span>
            <Input
              value={fromBranchId}
              onChange={(event) => setFromBranchId(event.target.value)}
              placeholder="branch UUID"
              disabled={pending}
              data-testid={`${resolvedTestIdPrefix}-from-branch-id`}
            />
          </label>

          <label className="space-y-2 text-sm text-ui-ink">
            <span className="text-xs uppercase tracking-wide text-ui-muted">To branch ID</span>
            <Input
              value={toBranchId}
              onChange={(event) => setToBranchId(event.target.value)}
              placeholder="branch UUID"
              disabled={pending}
              data-testid={`${resolvedTestIdPrefix}-to-branch-id`}
            />
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm text-ui-ink">
            <span className="text-xs uppercase tracking-wide text-ui-muted">
              Planned dispatch at
            </span>
            <Input
              value={plannedDispatchAt}
              onChange={(event) => setPlannedDispatchAt(event.target.value)}
              placeholder="2026-04-05T08:00:00Z"
              disabled={pending}
              data-testid={`${resolvedTestIdPrefix}-planned-dispatch-at`}
            />
          </label>

          <label className="space-y-2 text-sm text-ui-ink">
            <span className="text-xs uppercase tracking-wide text-ui-muted">
              Planned receive at
            </span>
            <Input
              value={plannedReceiveAt}
              onChange={(event) => setPlannedReceiveAt(event.target.value)}
              placeholder="2026-04-05T12:00:00Z"
              disabled={pending}
              data-testid={`${resolvedTestIdPrefix}-planned-receive-at`}
            />
          </label>
        </div>

        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">
            Shipment IDs
          </span>
          <Textarea
            value={shipmentIdsText}
            onChange={(event) => setShipmentIdsText(event.target.value)}
            placeholder={"One shipment UUID per line or comma-separated values."}
            rows={6}
            disabled={pending}
            data-testid={`${resolvedTestIdPrefix}-shipment-ids`}
          />
        </label>
      </details>

      {errorMessage ? (
        <div
          className="rounded-2xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted"
          data-testid={`${resolvedTestIdPrefix}-error`}
          id={errorId}
          role="alert"
        >
          {errorMessage}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild type="button" variant="ghost">
          <a href={normalizedReturnTo} data-testid={`${resolvedTestIdPrefix}-cancel`}>
            Back to transfer manifests
          </a>
        </Button>
        <Button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={pending || !organizationId?.trim()}
          data-testid={`${resolvedTestIdPrefix}-submit`}
        >
          {pending ? "Creating..." : "Create transfer manifest"}
        </Button>
      </div>
    </div>
  );
}
