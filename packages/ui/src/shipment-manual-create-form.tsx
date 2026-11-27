"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  createUiClient,
  type UiScope,
  type UiScopeOption,
  type UiCreateShipmentResult,
} from "@masarx/api";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { Button } from "./button";
import { Input } from "./input";
import { Select } from "./select";
import { useToast } from "./use-toast";
import { resolveOrganizationDisplayLabel, resolveScopeDisplayLabel } from "./shipment-create-lookup-options";
import { formatUiError, UiMessageError } from "./utils";
import { resolveUiRpcTimeoutMs, withTimeout } from "./promise-timeout";
import { useUnsavedChangesGuard } from "./use-unsaved-changes";
import { resolveSafeAppBasePath, resolveSafeHref } from "./url-guard";
import { normalizeAppHref } from "./navigation-paths";
import { normalizeShipmentAddressCapture, assertShipmentAddressCapture } from "./shipment-address-capture";

type ShipmentManualCreateFormProps = {
  appBasePath: string;
  requirePersistedReadback?: boolean;
  returnTo?: string | null;
  organizationId?: string | null;
  organizationName?: string | null;
  scopeOptions?: UiScopeOption[] | null;
  accessScope?: UiScope | null;
  capabilities?: string[] | null;
  capabilityWrite?: string | null;
  testIdPrefix?: string | null;
  serviceOfferings?: ShipmentServiceOfferingOption[] | null;
};

export type ShipmentServiceOfferingOption = {
  id: string;
  displayName: string;
  serviceLevelKey: string;
};

function normalizeReturnTo(value: string | null | undefined, fallback: string, appBasePath: string) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return fallback;
  const safeHref = resolveSafeHref("", trimmed);
  if (!safeHref) return fallback;
  try {
    const path = resolveSafeHref("", decodeURIComponent(safeHref.split(/[?#]/, 1)[0] ?? ""));
    if (!path) return fallback;
    const rootPath = normalizeAppHref(path, "");
    const base = resolveSafeAppBasePath(appBasePath) ?? "";
    if (path !== rootPath && path !== resolveSafeHref(base, rootPath)) return fallback;
  } catch {
    return fallback;
  }
  return safeHref;
}

function buildShipmentDetailHref(returnTo: string, shipmentId: string) {
  const url = new URL(returnTo, "https://ouikyoqziionthjyllvrvqmh.example.invalid");
  url.searchParams.set("id", shipmentId);
  url.searchParams.set("detail_open", "1");
  return `${url.pathname}${url.search}${url.hash}`;
}

function scopeLabel(scope: UiScope | null | undefined) {
  const scopeType = String(scope?.scope_type ?? "").trim().toLowerCase();
  if (scopeType === "client") return "Client scope";
  if (scopeType === "sender") return "Sender scope";
  if (scopeType === "tenant") return "Tenant scope";
  if (scopeType === "platform") return "Platform scope";
  return "Scoped session";
}

export function ShipmentManualCreateForm({
  appBasePath,
  requirePersistedReadback = false,
  returnTo,
  organizationId,
  organizationName,
  scopeOptions,
  accessScope,
  capabilities,
  capabilityWrite,
  testIdPrefix,
  serviceOfferings,
}: ShipmentManualCreateFormProps) {
  const router = useRouter();
  const { toast } = useToast();
  const scopeType = String(accessScope?.scope_type ?? "").trim().toLowerCase();
  const scopeId = String(accessScope?.scope_id ?? "").trim();
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "shipment-manual-create";
  const fallbackReturnTo = resolveSafeHref(appBasePath, "/resources/shipments") ?? "/resources/shipments";
  const normalizedReturnTo = React.useMemo(
    () => normalizeReturnTo(returnTo, fallbackReturnTo, appBasePath),
    [appBasePath, fallbackReturnTo, returnTo]
  );
  const resolvedCapabilityWrite = capabilityWrite?.trim() ?? "";
  const capabilitySet = React.useMemo(
    () => resolveCapabilitySet(capabilities ?? []),
    [capabilities]
  );
  const canCreate =
    resolvedCapabilityWrite.length > 0 &&
    hasCapability(capabilitySet, resolvedCapabilityWrite);
  const canResolvePermissions = resolvedCapabilityWrite.length > 0;

  const initialClientId = scopeType === "client" ? scopeId : "";
  const initialSenderId = scopeType === "sender" ? scopeId : "";
  const initialStatus = "pending";
  const [clientId, setClientId] = React.useState(initialClientId);
  const [senderId, setSenderId] = React.useState(initialSenderId);
  const [serviceType, setServiceType] = React.useState("");
  const [serviceOfferingId, setServiceOfferingId] = React.useState("");
  const [trackingNumber, setTrackingNumber] = React.useState("");
  const [clientReferenceNumber, setClientReferenceNumber] = React.useState("");
  const [carrierReferenceNumber, setCarrierReferenceNumber] = React.useState("");
  const [status, setStatus] = React.useState(initialStatus);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [committedResult, setCommittedResult] = React.useState<UiCreateShipmentResult | null>(null);
  const [pending, setPending] = React.useState(false);
  const [addressLine1, setAddressLine1] = React.useState("");
  const [addressCity, setAddressCity] = React.useState("");
  const [shortCode, setShortCode] = React.useState("");
  const [latitude, setLatitude] = React.useState("");
  const [longitude, setLongitude] = React.useState("");
  const [acceptedMessage, setAcceptedMessage] = React.useState<string | null>(null);
  const [submissionUncertain, setSubmissionUncertain] = React.useState(false);
  const submitLocked = pending || Boolean(acceptedMessage) || submissionUncertain;
  // A committed create keeps the draft frozen while still allowing a readback re-check.
  const submissionLocked = submitLocked || Boolean(committedResult);

  const hasChanges = Boolean(
    clientId.trim() !== initialClientId ||
      senderId.trim() !== initialSenderId ||
      serviceType.trim() ||
      serviceOfferingId.trim() ||
      trackingNumber.trim() ||
      clientReferenceNumber.trim() ||
      carrierReferenceNumber.trim() ||
      addressLine1.trim() || addressCity.trim() ||
      shortCode.trim() || latitude.trim() || longitude.trim() ||
      status.trim() !== initialStatus
  );

  useUnsavedChangesGuard({
    enabled: true,
    isSubmitting: pending,
    hasChanges: hasChanges && !acceptedMessage,
    warningMessage: "You have an unsaved shipment draft.",
  });

  const timeoutMs = React.useMemo(() => resolveUiRpcTimeoutMs(), []);
  const handleSubmit = React.useCallback(async () => {
    if (submitLocked) return;
    setErrorMessage(null);

    if (!organizationId?.trim()) {
      setErrorMessage("Shipment create requires an organization-scoped session.");
      return;
    }
    if (!serviceType.trim()) {
      setErrorMessage("Service type is required.");
      return;
    }
    if (!serviceOfferingId.trim()) {
      setErrorMessage("Service offering is required.");
      return;
    }
    if (scopeType !== "client" && scopeType !== "sender" && !clientId.trim()) {
      setErrorMessage("Client ID is required for this scope.");
      return;
    }
    if (!canCreate) {
      setErrorMessage(
        canResolvePermissions
          ? "You do not have permission to create shipments."
          : "Shipment create permissions are unavailable."
      );
      return;
    }

    let requestStarted = false;
    setPending(true);
    let result = committedResult;
    let createConfirmed = Boolean(committedResult);
    try {
      const capture = normalizeShipmentAddressCapture(shortCode, latitude, longitude);
      const hasAddress = Boolean(capture || addressLine1.trim() || addressCity.trim());
      if (hasAddress && (!addressLine1.trim() || !addressCity.trim())) {
        throw new UiMessageError("Destination address line 1 and city are required when entering an address.");
      }
      const destinationAddress = hasAddress ? {
        ...capture, line1: addressLine1.trim(), city: addressCity.trim(),
      } : undefined;
      const ui = createUiClient();
      const payload = {
        ...(destinationAddress ? { destinationAddress } : {}),
        clientId: clientId.trim() || null,
        senderId: senderId.trim() || null,
        serviceType: serviceType.trim(),
        serviceOfferingId: serviceOfferingId.trim(),
        trackingNumber: trackingNumber.trim() || null,
        clientReferenceNumber: clientReferenceNumber.trim() || null,
        carrierReferenceNumber: carrierReferenceNumber.trim() || null,
        status: status.trim() || null,
        metadata: {
          source: "ui.manual_create",
          app_base_path: appBasePath,
          return_to: normalizedReturnTo,
        },
      };

      if (!result) {
        requestStarted = true;
        result = await withTimeout(ui.createShipment(payload), timeoutMs);
      }

      const shipmentId = String(result?.shipment_id ?? "").trim();
      const workflowStatus = String(result?.workflow_status ?? "").trim().toLowerCase();
      const resultStatus = String(result?.status ?? "").trim().toLowerCase();
      if ([workflowStatus, resultStatus].some((value) => ["failed", "error", "blocked", "cancelled", "canceled"].includes(value))) {
        throw new UiMessageError("Shipment creation did not complete successfully.");
      }
      const completed = workflowStatus === "completed" ||
        (!workflowStatus && !result?.workflow_run_id && !destinationAddress && Boolean(shipmentId));
      if (!completed) {
        const runId = String(result?.workflow_run_id ?? "").trim();
        if (!runId) throw new Error("Shipment create returned no confirmed workflow outcome.");
        const message = "Shipment request accepted; creation and address capture are still pending.";
        setAcceptedMessage(message);
        if (shipmentId) router.push(buildShipmentDetailHref(normalizedReturnTo, shipmentId));
        return;
      }
      assertShipmentAddressCapture(destinationAddress, result?.destination_address_capture);
      if (!shipmentId) {
        throw new Error("Shipment create completed without returning shipment_id.");
      }

      if (requirePersistedReadback) {
        // Creation is confirmed from here on; only the persisted decision/audit readback can be pending.
        setCommittedResult(result);
        requestStarted = false;
        createConfirmed = true;
        const readback = await withTimeout(ui.rpc<{ visible: boolean }>("ui_shipment_create_readback_v1", {
          p_shipment_id: shipmentId,
          p_workflow_run_id: result?.workflow_run_id ?? null,
          p_correlation_id: result?.correlation_id ?? null,
        }), timeoutMs);
        if (readback?.visible !== true) {
          throw new UiMessageError("Shipment was saved, but its persisted decision and audit readback is not yet available. Check again before continuing.");
        }
      }

      setAcceptedMessage("Shipment creation completed. Open the shipment details to continue.");
      toast({
        tone: "success",
        title:
          String(result?.operation ?? "").trim() === "inserted"
            ? "Shipment created"
            : "Existing shipment reused",
        description: String(result?.tracking_number ?? "").trim() || undefined,
      });
      router.push(buildShipmentDetailHref(normalizedReturnTo, shipmentId));
    } catch (error) {
      const uncertain = requestStarted;
      if (uncertain) setSubmissionUncertain(true);
      const detail = formatUiError(error, createConfirmed ? "Persisted readback failed." : "Shipment create failed.");
      const message = createConfirmed
        ? `Shipment was saved; persisted confirmation is pending. ${detail}`
        : uncertain
          ? `${detail} The shipment outcome is unverified. Check shipments before trying again; do not resubmit this draft.`
          : detail;
      setErrorMessage(message);
      toast({
        tone: "error",
        title: createConfirmed ? "Shipment saved; confirmation pending"
          : uncertain ? "Shipment outcome unverified" : "Shipment create failed",
        description: message,
      });
    } finally {
      setPending(false);
    }
  }, [
    submitLocked,
    addressLine1,
    addressCity,
    shortCode,
    latitude,
    longitude,
    appBasePath,
    committedResult,
    requirePersistedReadback,
    canCreate,
    canResolvePermissions,
    carrierReferenceNumber,
    clientId,
    clientReferenceNumber,
    normalizedReturnTo,
    organizationId,
    pending,
    router,
    scopeType,
    senderId,
    serviceType,
    serviceOfferingId,
    status,
    timeoutMs,
    toast,
    trackingNumber,
  ]);

  const displayScope = resolveScopeDisplayLabel(accessScope, scopeOptions);
  const showClientField = scopeType !== "client" && scopeType !== "sender";
  const showSenderField = scopeType !== "sender";

  return (
    <div className="space-y-6" data-testid={`${resolvedTestIdPrefix}-form`}>
      <div className="grid gap-3 rounded-2xl border border-ui-border bg-ui-surface/60 p-4 text-sm text-ui-muted md:grid-cols-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-ui-muted/70">Organization</div>
          <div data-testid={`${resolvedTestIdPrefix}-organization`}>
            {resolveOrganizationDisplayLabel({ organizationId, organizationName }) || "Unavailable"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-ui-muted/70">Session scope</div>
          <div data-testid={`${resolvedTestIdPrefix}-scope`}>
            {scopeLabel(accessScope)}
            {displayScope ? ` - ${displayScope}` : ""}
          </div>
        </div>
      </div>

      {!canCreate ? (
        <div
          className="rounded-2xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted"
          data-testid={`${resolvedTestIdPrefix}-permissions`}
        >
          {canResolvePermissions
            ? "You do not have permission to create shipments from this surface."
            : "Shipment-create permissions are unavailable for this session."}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {showClientField ? (
          <label className="space-y-2 text-sm text-ui-ink">
            <span className="text-xs uppercase tracking-wide text-ui-muted">Client ID</span>
            <Input
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              placeholder="client UUID"
              disabled={submissionLocked}
              data-testid={`${resolvedTestIdPrefix}-client-id`}
            />
          </label>
        ) : (
          <div className="space-y-2 text-sm text-ui-ink">
            <div className="text-xs uppercase tracking-wide text-ui-muted">Client scope</div>
            <div
              className="rounded-xl border border-ui-border bg-ui-surface/70 px-3 py-2"
              data-testid={`${resolvedTestIdPrefix}-client-scope-id`}
            >
              {scopeId}
            </div>
          </div>
        )}

        {showSenderField ? (
          <label className="space-y-2 text-sm text-ui-ink">
            <span className="text-xs uppercase tracking-wide text-ui-muted">Sender ID</span>
            <Input
              value={senderId}
              onChange={(event) => setSenderId(event.target.value)}
              placeholder="optional sender UUID"
              disabled={submissionLocked}
              data-testid={`${resolvedTestIdPrefix}-sender-id`}
            />
          </label>
        ) : (
          <div className="space-y-2 text-sm text-ui-ink">
            <div className="text-xs uppercase tracking-wide text-ui-muted">Sender scope</div>
            <div
              className="rounded-xl border border-ui-border bg-ui-surface/70 px-3 py-2"
              data-testid={`${resolvedTestIdPrefix}-sender-scope-id`}
            >
              {scopeId}
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">Service type</span>
          <Input
            value={serviceType}
            onChange={(event) => setServiceType(event.target.value)}
            placeholder="delivery"
            disabled={submissionLocked}
            data-testid={`${resolvedTestIdPrefix}-service-type`}
          />
        </label>

        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">
            Service offering
          </span>
          <Select
            value={serviceOfferingId}
            onChange={(event) => setServiceOfferingId(event.target.value)}
            disabled={submissionLocked || !serviceOfferings?.length}
            data-testid={`${resolvedTestIdPrefix}-service-offering`}
          >
            <option value="">
              {serviceOfferings?.length
                ? "Select an active offering"
                : "No active offerings available"}
            </option>
            {(serviceOfferings ?? []).map((offering) => (
              <option key={offering.id} value={offering.id}>
                {offering.displayName} ({offering.serviceLevelKey})
              </option>
            ))}
          </Select>
        </label>

        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">Status</span>
          <Select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            disabled={submissionLocked}
            data-testid={`${resolvedTestIdPrefix}-status`}
          >
            <option value="pending">pending</option>
            <option value="created">created</option>
          </Select>
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">
            Tracking number
          </span>
          <Input
            value={trackingNumber}
            onChange={(event) => setTrackingNumber(event.target.value)}
            placeholder="leave blank to reserve from tracking policy"
            disabled={submissionLocked}
            data-testid={`${resolvedTestIdPrefix}-tracking-number`}
          />
        </label>

        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">
            Client reference
          </span>
          <Input
            value={clientReferenceNumber}
            onChange={(event) => setClientReferenceNumber(event.target.value)}
            placeholder="optional client reference"
            disabled={submissionLocked}
            data-testid={`${resolvedTestIdPrefix}-client-reference`}
          />
        </label>
      </div>

      <label className="space-y-2 text-sm text-ui-ink">
        <span className="text-xs uppercase tracking-wide text-ui-muted">
          Carrier reference
        </span>
        <Input
          value={carrierReferenceNumber}
          onChange={(event) => setCarrierReferenceNumber(event.target.value)}
          placeholder="optional carrier reference"
          disabled={submissionLocked}
          data-testid={`${resolvedTestIdPrefix}-carrier-reference`}
        />
      </label>

      <fieldset className="grid gap-4 md:grid-cols-3">
        <legend className="text-sm text-ui-ink">Destination address capture</legend>
        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">Destination address line 1</span>
          <Input name="destination_line1" value={addressLine1} autoComplete="address-line1"
            onChange={(event) => setAddressLine1(event.target.value)} disabled={submissionLocked}
            data-testid={`${resolvedTestIdPrefix}-address-line1`} />
        </label>
        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">Destination city</span>
          <Input name="destination_city" value={addressCity} autoComplete="address-level2"
            onChange={(event) => setAddressCity(event.target.value)} disabled={submissionLocked}
            data-testid={`${resolvedTestIdPrefix}-address-city`} />
        </label>
        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">Saudi short address (optional)</span>
          <Input name="short-code" value={shortCode}
            onChange={(event) => setShortCode(event.target.value)}
            disabled={submissionLocked}
            data-testid={`${resolvedTestIdPrefix}-short-code`} />
        </label>
        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">Latitude (optional)</span>
          <Input name="latitude" value={latitude} inputMode="decimal"
            onChange={(event) => setLatitude(event.target.value)}
            disabled={submissionLocked}
            data-testid={`${resolvedTestIdPrefix}-latitude`} />
        </label>
        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">Longitude (optional)</span>
          <Input name="longitude" value={longitude} inputMode="decimal"
            onChange={(event) => setLongitude(event.target.value)}
            disabled={submissionLocked}
            data-testid={`${resolvedTestIdPrefix}-longitude`} />
        </label>
      </fieldset>

      {acceptedMessage ? (
        <div role="status" data-testid={`${resolvedTestIdPrefix}-accepted`}>{acceptedMessage}</div>
      ) : null}

      {errorMessage ? (
        <div role="alert"
          className="rounded-2xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted"
          data-testid={`${resolvedTestIdPrefix}-error`}
        >
          {errorMessage}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild type="button" variant="ghost">
          <a href={normalizedReturnTo} data-testid={`${resolvedTestIdPrefix}-cancel`}>
            Back to shipments
          </a>
        </Button>
        <Button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitLocked || !organizationId?.trim()}
          data-testid={`${resolvedTestIdPrefix}-submit`}
        >
          {pending ? (committedResult ? "Checking..." : "Creating...") : committedResult ? "Check persisted shipment" : "Create shipment"}
        </Button>
      </div>
    </div>
  );
}
