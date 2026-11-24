"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
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
import { createUiTranslator } from "./i18n";

type ManifestTranslator = ReturnType<typeof createUiTranslator>;
const plannedTimestamp = z.iso.datetime({ offset: true });

// input is the field the error belongs to: an input, a textarea, or a lookup group holding a combobox.
type ManifestError = { message: string; input?: React.RefObject<HTMLElement | null> };

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

const SCOPE_TYPES = new Set(["tenant", "platform", "client", "sender"]);

function scopeLabel(scope: UiScope | null | undefined, t: ManifestTranslator) {
  const scopeType = String(scope?.scope_type ?? "").trim().toLowerCase();
  return t(`form.scope.${SCOPE_TYPES.has(scopeType) ? scopeType : "other"}`);
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

function parsePlannedTimestamp(value: string) {
  return plannedTimestamp.safeParse(value).success ? Date.parse(value) : Number.NaN;
}

function toLocalDateTime(value: string) {
  const date = new Date(parsePlannedTimestamp(value.trim()));
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
  const t = React.useMemo(() => createUiTranslator("ui.transferManifestCreate"), []);
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
  const [plannedDispatch, setPlannedDispatch] = React.useState({ value: "", raw: false });
  const [plannedReceive, setPlannedReceive] = React.useState({ value: "", raw: false });
  const dispatchInputRef = React.useRef<HTMLInputElement>(null);
  const receiveInputRef = React.useRef<HTMLInputElement>(null);
  const rawDispatchInputRef = React.useRef<HTMLInputElement>(null);
  const rawReceiveInputRef = React.useRef<HTMLInputElement>(null);
  const transferCodeInputRef = React.useRef<HTMLInputElement>(null);
  const fromBranchLookupRef = React.useRef<HTMLDivElement>(null);
  const toBranchLookupRef = React.useRef<HTMLDivElement>(null);
  const shipmentsLookupRef = React.useRef<HTMLDivElement>(null);
  const rawFromBranchInputRef = React.useRef<HTMLInputElement>(null);
  const rawToBranchInputRef = React.useRef<HTMLInputElement>(null);
  const rawShipmentsInputRef = React.useRef<HTMLTextAreaElement>(null);
  const errorId = React.useId();
  const [shipmentIdsText, setShipmentIdsText] = React.useState("");
  const [error, setError] = React.useState<ManifestError | null>(null);
  const [pending, setPending] = React.useState(false);
  const isErrorField = (ref: React.RefObject<HTMLElement | null>) => error?.input === ref;

  React.useLayoutEffect(() => {
    const input = error?.input?.current;
    if (!input) return;
    const details = input.closest("details");
    if (details) details.open = true;
    (input.querySelector<HTMLElement>('[role="combobox"]') ?? input).focus();
  }, [error]);

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
      plannedDispatch.value.trim() ||
      plannedReceive.value.trim() ||
      shipmentIdsText.trim()
  );

  useUnsavedChangesGuard({
    enabled: true,
    isSubmitting: pending,
    hasChanges,
    warningMessage: t("form.unsavedWarning"),
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
    setError(null);

    if (!organizationId?.trim()) {
      setError({ message: t("errors.organizationRequired") });
      return;
    }
    if (!transferCode.trim()) {
      setError({ message: t("errors.transferCodeRequired"), input: transferCodeInputRef });
      return;
    }
    if (!fromBranchId.trim() || !toBranchId.trim()) {
      // Point at the first missing branch: the lookup when it is usable, otherwise the raw ID field.
      const input = !fromBranchId.trim()
        ? lookupEnabled ? fromBranchLookupRef : rawFromBranchInputRef
        : lookupEnabled ? toBranchLookupRef : rawToBranchInputRef;
      setError({ message: t("errors.branchesRequired"), input });
      return;
    }
    if (shipmentIds.length < 1) {
      setError({ message: t("errors.shipmentsRequired"), input: lookupEnabled ? shipmentsLookupRef : rawShipmentsInputRef });
      return;
    }
    if (!canCreate) {
      setError({
        message: canResolvePermissions
          ? t("errors.permissionDenied")
          : t("errors.permissionsUnavailable"),
      });
      return;
    }
    const dispatchTime = plannedDispatch.value.trim();
    const receiveTime = plannedReceive.value.trim();
    const dispatchMillis = parsePlannedTimestamp(dispatchTime);
    const receiveMillis = parsePlannedTimestamp(receiveTime);
    if (dispatchTime && Number.isNaN(dispatchMillis)) {
      setError({ message: t("errors.invalidDispatch"), input: plannedDispatch.raw ? rawDispatchInputRef : dispatchInputRef });
      return;
    }
    if ((receiveTime && Number.isNaN(receiveMillis)) || receiveMillis < dispatchMillis) {
      setError({
        message: Number.isNaN(receiveMillis) ? t("errors.invalidReceive") : t("errors.receiveBeforeDispatch"),
        input: plannedReceive.raw ? rawReceiveInputRef : receiveInputRef,
      });
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
        throw new Error(t("errors.missingTransferId"));
      }

      toast({
        tone: "success",
        title:
          String(result?.operation ?? "").trim() === "inserted"
            ? t("toast.created")
            : t("toast.reused"),
        description: transferCode.trim(),
      });
      router.push(buildTransferDetailHref(normalizedReturnTo, transferId));
    } catch (error) {
      const message = formatUiError(error, t("errors.createFailed"));
      setError({ message });
      toast({
        tone: "error",
        title: t("toast.failed"),
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
    lookupEnabled,
    normalizedReturnTo,
    organizationId,
    pending,
    plannedDispatch,
    plannedReceive,
    router,
    shipmentIds,
    shouldRetry,
    t,
    timeoutMs,
    toast,
    toBranchId,
    transferCode,
  ]);

  return (
    <div className="space-y-6" data-testid={`${resolvedTestIdPrefix}-form`}>
      <div className="grid gap-3 rounded-2xl border border-ui-border bg-ui-surface/60 p-4 text-sm text-ui-muted md:grid-cols-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-ui-muted/70">{t("form.organization")}</div>
          <div data-testid={`${resolvedTestIdPrefix}-organization`}>
            {organizationId?.trim()
              ? accessScope?.scope_type === "tenant" && scopeId === organizationId.trim() && accessScope.scope_label?.trim()
                ? accessScope.scope_label
                : formatReferenceValue(organizationId.trim())
              : t("form.unavailable")}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-ui-muted/70">{t("form.sessionScope")}</div>
          <div data-testid={`${resolvedTestIdPrefix}-scope`}>
            {accessScope?.scope_label?.trim() || scopeLabel(accessScope, t)}
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
            ? t("form.permissionsDenied")
            : t("form.permissionsUnavailable")}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">{t("form.transferCode")}</span>
          <Input
            ref={transferCodeInputRef}
            invalid={isErrorField(transferCodeInputRef)}
            aria-describedby={isErrorField(transferCodeInputRef) ? errorId : undefined}
            value={transferCode}
            onChange={(event) => setTransferCode(event.target.value)}
            placeholder="XFER-20260404-001"
            disabled={pending}
            data-testid={`${resolvedTestIdPrefix}-transfer-code`}
          />
        </label>

        <div className="space-y-2 rounded-2xl border border-ui-border bg-ui-surface/60 px-4 py-3 text-sm text-ui-muted">
          <div className="text-xs uppercase tracking-wide text-ui-muted/70">{t("form.manifestSize")}</div>
          <div data-testid={`${resolvedTestIdPrefix}-shipment-count`}>
            {t("form.shipmentCount", { count: shipmentIds.length })}
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div ref={fromBranchLookupRef} className="space-y-2" role="group" aria-labelledby={`${resolvedTestIdPrefix}-from-branch-label`}>
          <span id={`${resolvedTestIdPrefix}-from-branch-label`} className="text-sm text-ui-ink">{t("form.fromBranch")}</span>
          <RelationField value={fromBranchId} onChange={(value) => setFromBranchId(String(value))}
            aria-invalid={isErrorField(fromBranchLookupRef)}
            aria-describedby={isErrorField(fromBranchLookupRef) ? errorId : undefined}
            options={branchOptions.filter((item) => item.value === fromBranchId)} fetcher={lookupEnabled ? fetchBranches : undefined}
            placeholder={t("form.fromBranchPlaceholder")} disabled={pending || !lookupEnabled} />
        </div>
        <div ref={toBranchLookupRef} className="space-y-2" role="group" aria-labelledby={`${resolvedTestIdPrefix}-to-branch-label`}>
          <span id={`${resolvedTestIdPrefix}-to-branch-label`} className="text-sm text-ui-ink">{t("form.toBranch")}</span>
          <RelationField value={toBranchId} onChange={(value) => setToBranchId(String(value))}
            aria-invalid={isErrorField(toBranchLookupRef)}
            aria-describedby={isErrorField(toBranchLookupRef) ? errorId : undefined}
            options={branchOptions.filter((item) => item.value === toBranchId)} fetcher={lookupEnabled ? fetchBranches : undefined}
            placeholder={t("form.toBranchPlaceholder")} disabled={pending || !lookupEnabled} />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2 text-sm text-ui-ink">
          <span>{t("form.plannedDispatchLocal")}</span>
          <Input ref={dispatchInputRef} type="datetime-local" value={toLocalDateTime(plannedDispatch.value)}
            invalid={error?.input === dispatchInputRef}
            aria-describedby={error?.input === dispatchInputRef ? errorId : undefined}
            onChange={(event) => setPlannedDispatch({ value: fromLocalDateTime(event.target.value), raw: false })} disabled={pending} />
        </label>
        <label className="space-y-2 text-sm text-ui-ink">
          <span>{t("form.plannedReceiveLocal")}</span>
          <Input ref={receiveInputRef} type="datetime-local" value={toLocalDateTime(plannedReceive.value)}
            invalid={error?.input === receiveInputRef}
            aria-describedby={error?.input === receiveInputRef ? errorId : undefined}
            onChange={(event) => setPlannedReceive({ value: fromLocalDateTime(event.target.value), raw: false })} disabled={pending} />
        </label>
      </div>

      <div ref={shipmentsLookupRef} className="space-y-2" role="group" aria-labelledby={`${resolvedTestIdPrefix}-shipments-label`}>
        <span id={`${resolvedTestIdPrefix}-shipments-label`} className="text-sm text-ui-ink">{t("form.shipments")}</span>
        <RelationField mode="multi" value={shipmentIds}
          aria-invalid={isErrorField(shipmentsLookupRef)}
          aria-describedby={isErrorField(shipmentsLookupRef) ? errorId : undefined}
          onChange={(value) => setShipmentIdsText(Array.isArray(value) ? value.join("\n") : value)}
          options={shipmentOptions.filter((item) => shipmentIds.includes(item.value))}
          fetcher={lookupEnabled ? fetchShipments : undefined}
          placeholder={t("form.shipmentsPlaceholder")} disabled={pending || !lookupEnabled} />
      </div>

      <details className="space-y-3">
        <summary className="text-sm text-ui-muted">{t("form.rawSection")}</summary>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm text-ui-ink">
            <span className="text-xs uppercase tracking-wide text-ui-muted">{t("form.fromBranchId")}</span>
            <Input
              ref={rawFromBranchInputRef}
              invalid={isErrorField(rawFromBranchInputRef)}
              aria-describedby={isErrorField(rawFromBranchInputRef) ? errorId : undefined}
              value={fromBranchId}
              onChange={(event) => setFromBranchId(event.target.value)}
              placeholder={t("form.branchIdPlaceholder")}
              disabled={pending}
              data-testid={`${resolvedTestIdPrefix}-from-branch-id`}
            />
          </label>

          <label className="space-y-2 text-sm text-ui-ink">
            <span className="text-xs uppercase tracking-wide text-ui-muted">{t("form.toBranchId")}</span>
            <Input
              ref={rawToBranchInputRef}
              invalid={isErrorField(rawToBranchInputRef)}
              aria-describedby={isErrorField(rawToBranchInputRef) ? errorId : undefined}
              value={toBranchId}
              onChange={(event) => setToBranchId(event.target.value)}
              placeholder={t("form.branchIdPlaceholder")}
              disabled={pending}
              data-testid={`${resolvedTestIdPrefix}-to-branch-id`}
            />
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm text-ui-ink">
            <span className="text-xs uppercase tracking-wide text-ui-muted">
              {t("form.plannedDispatchAt")}
            </span>
            <Input
              ref={rawDispatchInputRef}
              value={plannedDispatch.value}
              invalid={error?.input === rawDispatchInputRef}
              aria-describedby={error?.input === rawDispatchInputRef ? errorId : undefined}
              onChange={(event) => setPlannedDispatch({ value: event.target.value, raw: true })}
              placeholder="2026-04-05T08:00:00Z"
              disabled={pending}
              data-testid={`${resolvedTestIdPrefix}-planned-dispatch-at`}
            />
          </label>

          <label className="space-y-2 text-sm text-ui-ink">
            <span className="text-xs uppercase tracking-wide text-ui-muted">
              {t("form.plannedReceiveAt")}
            </span>
            <Input
              ref={rawReceiveInputRef}
              value={plannedReceive.value}
              invalid={error?.input === rawReceiveInputRef}
              aria-describedby={error?.input === rawReceiveInputRef ? errorId : undefined}
              onChange={(event) => setPlannedReceive({ value: event.target.value, raw: true })}
              placeholder="2026-04-05T12:00:00Z"
              disabled={pending}
              data-testid={`${resolvedTestIdPrefix}-planned-receive-at`}
            />
          </label>
        </div>

        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">
            {t("form.shipmentIds")}
          </span>
          <Textarea
            ref={rawShipmentsInputRef}
            aria-invalid={isErrorField(rawShipmentsInputRef) || undefined}
            aria-describedby={isErrorField(rawShipmentsInputRef) ? errorId : undefined}
            value={shipmentIdsText}
            onChange={(event) => setShipmentIdsText(event.target.value)}
            placeholder={t("form.shipmentIdsPlaceholder")}
            rows={6}
            disabled={pending}
            data-testid={`${resolvedTestIdPrefix}-shipment-ids`}
          />
        </label>
      </details>

      {error ? (
        <div
          className="rounded-2xl border border-ui-danger/30 bg-ui-danger/5 p-3 text-sm text-ui-ink"
          data-testid={`${resolvedTestIdPrefix}-error`}
          id={errorId}
          role="alert"
        >
          {error.message}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild type="button" variant="ghost">
          <a href={normalizedReturnTo} data-testid={`${resolvedTestIdPrefix}-cancel`}>
            {t("form.back")}
          </a>
        </Button>
        <Button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={pending || !organizationId?.trim()}
          data-testid={`${resolvedTestIdPrefix}-submit`}
        >
          {pending ? t("form.creating") : t("form.submit")}
        </Button>
      </div>
    </div>
  );
}
