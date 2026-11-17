"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  createUiClient,
  isRetriableNetworkError,
  isRetriableSupabaseError,
  type UiScope,
} from "@masarx/api";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { Button } from "./button";
import { Input } from "./input";
import { Select } from "./select";
import { useToast } from "./use-toast";
import { formatUiError } from "./utils";
import { isTimeoutError, resolveUiRpcTimeoutMs, withTimeout } from "./promise-timeout";
import { useUnsavedChangesGuard } from "./use-unsaved-changes";

type ShipmentManualCreateFormProps = {
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
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return fallback;
  }
  return trimmed;
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
  returnTo,
  organizationId,
  accessScope,
  capabilities,
  capabilityWrite,
  testIdPrefix,
}: ShipmentManualCreateFormProps) {
  const router = useRouter();
  const { toast } = useToast();
  const scopeType = String(accessScope?.scope_type ?? "").trim().toLowerCase();
  const scopeId = String(accessScope?.scope_id ?? "").trim();
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "shipment-manual-create";
  const fallbackReturnTo = `${appBasePath}/resources/shipments`;
  const normalizedReturnTo = React.useMemo(
    () => normalizeReturnTo(returnTo, fallbackReturnTo),
    [fallbackReturnTo, returnTo]
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

  const [clientId, setClientId] = React.useState(scopeType === "client" ? scopeId : "");
  const [senderId, setSenderId] = React.useState(scopeType === "sender" ? scopeId : "");
  const [serviceType, setServiceType] = React.useState("");
  const [trackingNumber, setTrackingNumber] = React.useState("");
  const [clientReferenceNumber, setClientReferenceNumber] = React.useState("");
  const [carrierReferenceNumber, setCarrierReferenceNumber] = React.useState("");
  const [status, setStatus] = React.useState("pending");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const hasChanges = Boolean(
    clientId.trim() ||
      senderId.trim() ||
      serviceType.trim() ||
      trackingNumber.trim() ||
      clientReferenceNumber.trim() ||
      carrierReferenceNumber.trim() ||
      status.trim()
  );

  useUnsavedChangesGuard({
    enabled: true,
    isSubmitting: pending,
    hasChanges,
    warningMessage: "You have an unsaved shipment draft.",
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
      setErrorMessage("Shipment create requires an organization-scoped session.");
      return;
    }
    if (!serviceType.trim()) {
      setErrorMessage("Service type is required.");
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

    setPending(true);
    try {
      const ui = createUiClient();
      const payload = {
        clientId: clientId.trim() || null,
        senderId: senderId.trim() || null,
        serviceType: serviceType.trim(),
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

      let result: Awaited<ReturnType<typeof ui.createShipment>> | null = null;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          result = await withTimeout(ui.createShipment(payload), timeoutMs);
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= 2 || !shouldRetry(error)) throw error;
          await delay(800);
        }
      }

      if (!result && lastError) throw lastError;

      const shipmentId = String(result?.shipment_id ?? "").trim();
      if (!shipmentId) {
        throw new Error("Shipment create completed without returning shipment_id.");
      }

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
      const message = formatUiError(error, "Shipment create failed.");
      setErrorMessage(message);
      toast({
        tone: "error",
        title: "Shipment create failed",
        description: message,
      });
    } finally {
      setPending(false);
    }
  }, [
    appBasePath,
    canCreate,
    canResolvePermissions,
    carrierReferenceNumber,
    clientId,
    clientReferenceNumber,
    delay,
    normalizedReturnTo,
    organizationId,
    pending,
    router,
    scopeType,
    senderId,
    serviceType,
    shouldRetry,
    status,
    timeoutMs,
    toast,
    trackingNumber,
  ]);

  const showClientField = scopeType !== "client" && scopeType !== "sender";
  const showSenderField = scopeType !== "sender";

  return (
    <div className="space-y-6" data-testid={`${resolvedTestIdPrefix}-form`}>
      <div className="grid gap-3 rounded-2xl border border-ui-border bg-ui-surface/60 p-4 text-sm text-ui-muted md:grid-cols-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-ui-muted/70">Organization</div>
          <div data-testid={`${resolvedTestIdPrefix}-organization`}>
            {organizationId?.trim() || "Unavailable"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-ui-muted/70">Session scope</div>
          <div data-testid={`${resolvedTestIdPrefix}-scope`}>
            {scopeLabel(accessScope)}
            {scopeId ? ` - ${scopeId}` : ""}
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
              disabled={pending}
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
              disabled={pending}
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
            disabled={pending}
            data-testid={`${resolvedTestIdPrefix}-service-type`}
          />
        </label>

        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">Status</span>
          <Select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            disabled={pending}
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
            disabled={pending}
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
            disabled={pending}
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
          disabled={pending}
          data-testid={`${resolvedTestIdPrefix}-carrier-reference`}
        />
      </label>

      {errorMessage ? (
        <div
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
          disabled={pending || !organizationId?.trim()}
          data-testid={`${resolvedTestIdPrefix}-submit`}
        >
          {pending ? "Creating..." : "Create shipment"}
        </Button>
      </div>
    </div>
  );
}
