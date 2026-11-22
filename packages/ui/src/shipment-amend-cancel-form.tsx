"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Button } from "./button";
import { Input } from "./input";
import { Section } from "./section";
import { Textarea } from "./textarea";
import { getShipmentModifyAllowedFields } from "./shipment-amend-cancel-policy";

export type ShipmentAmendCancelState = {
  status: "idle" | "error" | "success";
  message?: string;
  locked?: boolean;
};

type OperationState = {
  allowed: boolean;
  reason?: string | null;
  allowed_statuses?: string[] | null;
  window_hours?: number | null;
};

export type ShipmentAmendCancelOptions = {
  lock_source?: string | null;
  operations?: {
    modify?: OperationState | null;
    reschedule?: OperationState | null;
    address?: OperationState | null;
    cancel?: OperationState | null;
    return?: OperationState | null;
  } | null;
  policy?: {
    delete_window_hours?: number | null;
    modify_allowed_fields?: string[] | null;
    address_default_country_code?: string | null;
  } | null;
};

export type ShipmentCurrentValues = {
  trackingNumber?: string | null;
  status?: string | null;
  promisedDeliveryDate?: string | null;
  serviceType?: string | null;
  serviceLevel?: string | null;
  specialInstructions?: string | null;
  clientReferenceNumber?: string | null;
  carrierReferenceNumber?: string | null;
  codAmount?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  addressCity?: string | null;
  addressProvince?: string | null;
  addressCountry?: string | null;
  addressPostalCode?: string | null;
  addressDistrict?: string | null;
  addressBuildingNumber?: string | null;
  addressAdditionalDirections?: string | null;
};

type ShipmentAmendCancelFormProps = {
  action: (
    prevState: ShipmentAmendCancelState,
    formData: FormData,
  ) => Promise<ShipmentAmendCancelState>;
  shipmentId: string;
  options: ShipmentAmendCancelOptions;
  currentValues: ShipmentCurrentValues;
  testIdPrefix: string;
};

const initialState: ShipmentAmendCancelState = { status: "idle" };

function formatStatuses(value: string[] | null | undefined) {
  const items = Array.isArray(value) ? value.filter(Boolean) : [];
  return items.length ? items.join(", ") : "No statuses configured";
}

function blockedMessage(
  operation: string,
  state: OperationState | null | undefined,
  options: ShipmentAmendCancelOptions,
) {
  if (!state) return `Blocked by shipment_operation_policy: ${operation} availability was not returned by the backend.`;
  if (state.allowed === true) return null;
  if (state.reason === "shipment_delete_window_expired") {
    const hours = state.window_hours ?? options.policy?.delete_window_hours ?? null;
    return hours
      ? `Blocked by shipment_operation_policy: cancel is limited to the first ${hours} hours after creation.`
      : "Blocked by shipment_operation_policy: cancel window expired.";
  }
  if (state.reason === "shipment_status_not_allowed") {
    return `Blocked by shipment_operation_policy: ${operation} is limited to statuses ${formatStatuses(
      state.allowed_statuses,
    )}.`;
  }
  return `Blocked by shipment_operation_policy: ${state.reason ?? "operation unavailable"}.`;
}

export function ShipmentAmendCancelForm({
  action,
  shipmentId,
  options,
  currentValues,
  testIdPrefix,
}: ShipmentAmendCancelFormProps) {
  const [state, formAction, isPending] = React.useActionState(action, initialState);
  const submissionLocked = isPending || state.locked === true;
  const modifyState = options.operations?.modify ?? null;
  const modifyAllowedFields = getShipmentModifyAllowedFields(options);
  const rescheduleState = options.operations?.reschedule ?? null;
  const addressState = options.operations?.address ?? null;
  const cancelState = options.operations?.cancel ?? null;
  const returnState = options.operations?.return ?? null;
  const t = useTranslations("ui.shipmentAmendCancel");
  const returnBlocked = returnState && blockedMessage("return", returnState, options);

  return (
    <div className="space-y-4" data-testid={`${testIdPrefix}-panel`}>
      <Section
        title="Amend / cancel"
        description="Temporary pre-dispatch lock is enforced only from shipment_operation_policy until route-freeze SSOT lands."
        testId={`${testIdPrefix}-section`}
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted">
            <div>
              Tracking: <span className="font-medium text-ui-ink">{currentValues.trackingNumber ?? shipmentId}</span>
            </div>
            <div>Current status: {currentValues.status ?? "Unknown"}</div>
            <div>Lock source: {options.lock_source ?? "shipment_operation_policy"}</div>
          </div>

          <form action={formAction} className="space-y-3" data-testid={`${testIdPrefix}-modify-form`}>
            <input type="hidden" name="shipment_id" value={shipmentId} />
            <input type="hidden" name="operation" value="modify" />
            <div className="text-sm font-semibold text-ui-ink">Modify shipment</div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Service type</span>
                <Input
                  name="service_type"
                  defaultValue={currentValues.serviceType ?? ""}
                  disabled={submissionLocked || modifyState?.allowed !== true || !modifyAllowedFields.has("service_type")}
                  data-testid={`${testIdPrefix}-modify-service-type`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Service level</span>
                <Input
                  name="service_level"
                  defaultValue={currentValues.serviceLevel ?? ""}
                  disabled={submissionLocked || modifyState?.allowed !== true || !modifyAllowedFields.has("service_level")}
                  data-testid={`${testIdPrefix}-modify-service-level`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Client reference</span>
                <Input
                  name="client_reference_number"
                  defaultValue={currentValues.clientReferenceNumber ?? ""}
                  disabled={submissionLocked || modifyState?.allowed !== true || !modifyAllowedFields.has("client_reference_number")}
                  data-testid={`${testIdPrefix}-modify-client-reference`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Carrier reference</span>
                <Input
                  name="carrier_reference_number"
                  defaultValue={currentValues.carrierReferenceNumber ?? ""}
                  disabled={submissionLocked || modifyState?.allowed !== true || !modifyAllowedFields.has("carrier_reference_number")}
                  data-testid={`${testIdPrefix}-modify-carrier-reference`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink md:col-span-2">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Special instructions</span>
                <Textarea
                  name="special_instructions"
                  rows={3}
                  defaultValue={currentValues.specialInstructions ?? ""}
                  disabled={submissionLocked || modifyState?.allowed !== true || !modifyAllowedFields.has("special_instructions")}
                  data-testid={`${testIdPrefix}-modify-special-instructions`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">COD amount</span>
                <Input
                  name="cod_amount"
                  defaultValue={currentValues.codAmount ?? ""}
                  disabled={submissionLocked || modifyState?.allowed !== true || !modifyAllowedFields.has("cod_amount")}
                  data-testid={`${testIdPrefix}-modify-cod-amount`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink md:col-span-2">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Metadata JSON</span>
                <Textarea
                  name="metadata_json"
                  rows={4}
                  placeholder='{"priority":"vip"}'
                  disabled={submissionLocked || modifyState?.allowed !== true || !modifyAllowedFields.has("metadata")}
                  data-testid={`${testIdPrefix}-modify-metadata`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink md:col-span-2">
                <span className="text-xs uppercase tracking-wide text-ui-muted">References JSON</span>
                <Textarea
                  name="references_json"
                  rows={4}
                  placeholder='{"logistics_reference_number":["REF-001"]}'
                  disabled={submissionLocked || modifyState?.allowed !== true || !modifyAllowedFields.has("references")}
                  data-testid={`${testIdPrefix}-modify-references`}
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                disabled={submissionLocked || modifyState?.allowed !== true || modifyAllowedFields.size === 0}
                data-testid={`${testIdPrefix}-modify-submit`}
              >
                {isPending ? "Saving..." : "Apply modify"}
              </Button>
              <span className="text-xs text-ui-muted">
                Allowed statuses: {formatStatuses(modifyState?.allowed_statuses)}
              </span>
            </div>
            {blockedMessage("modify", modifyState, options) ? (
              <div className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted">
                {blockedMessage("modify", modifyState, options)}
              </div>
            ) : null}
          </form>

          <form action={formAction} className="space-y-3" data-testid={`${testIdPrefix}-reschedule-form`}>
            <input type="hidden" name="shipment_id" value={shipmentId} />
            <input type="hidden" name="operation" value="reschedule" />
            <div className="text-sm font-semibold text-ui-ink">Reschedule</div>
            <label className="space-y-1 text-sm text-ui-ink">
              <span className="text-xs uppercase tracking-wide text-ui-muted">Promised delivery date</span>
              <Input
                type="date"
                name="slot_date"
                defaultValue={currentValues.promisedDeliveryDate ?? ""}
                disabled={submissionLocked || rescheduleState?.allowed !== true}
                data-testid={`${testIdPrefix}-reschedule-slot-date`}
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                disabled={submissionLocked || rescheduleState?.allowed !== true}
                data-testid={`${testIdPrefix}-reschedule-submit`}
              >
                {isPending ? "Saving..." : "Reserve slot"}
              </Button>
              <span className="text-xs text-ui-muted">
                Allowed statuses: {formatStatuses(rescheduleState?.allowed_statuses)}
              </span>
            </div>
            {blockedMessage("reschedule", rescheduleState, options) ? (
              <div className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted">
                {blockedMessage("reschedule", rescheduleState, options)}
              </div>
            ) : null}
          </form>

          <form action={formAction} className="space-y-3" data-testid={`${testIdPrefix}-address-form`}>
            <input type="hidden" name="shipment_id" value={shipmentId} />
            <input type="hidden" name="operation" value="address" />
            <div className="text-sm font-semibold text-ui-ink">Update address</div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Saudi short address (optional)</span>
                <Input name="sa_short_code"
                  disabled={submissionLocked || addressState?.allowed !== true}
                  data-testid={`${testIdPrefix}-address-short-code`} />
              </label>
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Latitude (optional)</span>
                <Input name="latitude" inputMode="decimal"
                  disabled={submissionLocked || addressState?.allowed !== true}
                  data-testid={`${testIdPrefix}-address-latitude`} />
              </label>
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Longitude (optional)</span>
                <Input name="longitude" inputMode="decimal"
                  disabled={submissionLocked || addressState?.allowed !== true}
                  data-testid={`${testIdPrefix}-address-longitude`} />
              </label>
              <label className="space-y-1 text-sm text-ui-ink md:col-span-2">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Address line 1</span>
                <Textarea
                  name="line1"
                  rows={2}
                  defaultValue={currentValues.addressLine1 ?? ""}
                  disabled={submissionLocked || addressState?.allowed !== true}
                  data-testid={`${testIdPrefix}-address-line1`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Address line 2</span>
                <Input
                  name="line2"
                  defaultValue={currentValues.addressLine2 ?? ""}
                  disabled={submissionLocked || addressState?.allowed !== true}
                  data-testid={`${testIdPrefix}-address-line2`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">City</span>
                <Input
                  name="city"
                  defaultValue={currentValues.addressCity ?? ""}
                  disabled={submissionLocked || addressState?.allowed !== true}
                  data-testid={`${testIdPrefix}-address-city`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Province / region</span>
                <Input
                  name="province"
                  defaultValue={currentValues.addressProvince ?? ""}
                  disabled={submissionLocked || addressState?.allowed !== true}
                  data-testid={`${testIdPrefix}-address-province`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Country</span>
                <Input
                  name="country"
                  defaultValue={
                    currentValues.addressCountry ?? options.policy?.address_default_country_code ?? ""
                  }
                  disabled={submissionLocked || addressState?.allowed !== true}
                  data-testid={`${testIdPrefix}-address-country`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Postal code</span>
                <Input
                  name="postal_code"
                  defaultValue={currentValues.addressPostalCode ?? ""}
                  disabled={submissionLocked || addressState?.allowed !== true}
                  data-testid={`${testIdPrefix}-address-postal-code`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">District</span>
                <Input
                  name="district"
                  defaultValue={currentValues.addressDistrict ?? ""}
                  disabled={submissionLocked || addressState?.allowed !== true}
                  data-testid={`${testIdPrefix}-address-district`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Building number</span>
                <Input
                  name="building_number"
                  defaultValue={currentValues.addressBuildingNumber ?? ""}
                  disabled={submissionLocked || addressState?.allowed !== true}
                  data-testid={`${testIdPrefix}-address-building-number`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink md:col-span-2">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Raw input / operator notes</span>
                <Textarea
                  name="raw_input"
                  rows={3}
                  disabled={submissionLocked || addressState?.allowed !== true}
                  data-testid={`${testIdPrefix}-address-raw-input`}
                />
              </label>
              <label className="space-y-1 text-sm text-ui-ink md:col-span-2">
                <span className="text-xs uppercase tracking-wide text-ui-muted">Additional directions</span>
                <Textarea
                  name="additional_directions"
                  rows={3}
                  defaultValue={currentValues.addressAdditionalDirections ?? ""}
                  disabled={submissionLocked || addressState?.allowed !== true}
                  data-testid={`${testIdPrefix}-address-directions`}
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                disabled={submissionLocked || addressState?.allowed !== true}
                data-testid={`${testIdPrefix}-address-submit`}
              >
                {isPending ? "Saving..." : "Apply address change"}
              </Button>
              <span className="text-xs text-ui-muted">
                Allowed statuses: {formatStatuses(addressState?.allowed_statuses)}
              </span>
            </div>
            {blockedMessage("address", addressState, options) ? (
              <div className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted">
                {blockedMessage("address", addressState, options)}
              </div>
            ) : null}
          </form>

          <form action={formAction} className="space-y-3" data-testid={`${testIdPrefix}-cancel-form`}>
            <input type="hidden" name="shipment_id" value={shipmentId} />
            <input type="hidden" name="operation" value="cancel" />
            <div className="text-sm font-semibold text-ui-ink">Soft-cancel shipment</div>
            <label className="space-y-1 text-sm text-ui-ink">
              <span className="text-xs uppercase tracking-wide text-ui-muted">Reason</span>
              <Textarea
                name="cancel_reason"
                rows={3}
                disabled={submissionLocked || cancelState?.allowed !== true}
                data-testid={`${testIdPrefix}-cancel-reason`}
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                variant="soft"
                disabled={submissionLocked || cancelState?.allowed !== true}
                data-testid={`${testIdPrefix}-cancel-submit`}
              >
                {isPending ? "Saving..." : "Soft-cancel"}
              </Button>
              <span className="text-xs text-ui-muted">
                Allowed statuses: {formatStatuses(cancelState?.allowed_statuses)}
              </span>
            </div>
            {blockedMessage("cancel", cancelState, options) ? (
              <div className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted">
                {blockedMessage("cancel", cancelState, options)}
              </div>
            ) : null}
          </form>

          {returnState ? (
            <form action={formAction} className="space-y-3" data-testid={`${testIdPrefix}-return-form`}>
              <input type="hidden" name="shipment_id" value={shipmentId} />
              <input type="hidden" name="operation" value="return" />
              <div className="text-sm font-semibold text-ui-ink">{t("returnToOriginShipment")}</div>
              <label className="space-y-1 text-sm text-ui-ink">
                <span className="text-xs uppercase tracking-wide text-ui-muted">{t("returnReason")}</span>
                <Textarea
                  name="return_reason"
                  rows={3}
                  disabled={submissionLocked || returnState?.allowed !== true}
                  data-testid={`${testIdPrefix}-return-reason`}
                />
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  variant="soft"
                  disabled={submissionLocked || returnState?.allowed !== true}
                  data-testid={`${testIdPrefix}-return-submit`}
                >
                  {isPending ? "Saving..." : t("returnToOrigin")}
                </Button>
                <span className="text-xs text-ui-muted">
                  Allowed statuses: {formatStatuses(returnState?.allowed_statuses)}
                </span>
              </div>
              {returnBlocked ? (
                <div className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted">
                  {returnBlocked}
                </div>
              ) : null}
            </form>
          ) : null}

          {state.status === "error" ? (
            <div
              className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted"
              data-testid={`${testIdPrefix}-error`}
            >
              {state.message ?? "Shipment amend/cancel failed."}
            </div>
          ) : null}

          {state.status === "success" ? (
            <div
              className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm"
              data-testid={`${testIdPrefix}-success`}
            >
              {state.message ?? "Shipment updated."}
            </div>
          ) : null}
        </div>
      </Section>
    </div>
  );
}
