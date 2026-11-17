import "server-only";

import { revalidatePath } from "next/cache";
import { createServerClient } from "@masarx/auth/server";
import { ContextNotice } from "./context-notice";
import { PageContainer } from "./page-container";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import {
  ShipmentAmendCancelForm,
  ShipmentAmendCancelOptions,
  ShipmentAmendCancelState,
  ShipmentCurrentValues,
} from "./shipment-amend-cancel-form";
import { Button } from "./button";
import { formatUiError } from "./utils";
import { resolveSafeHref } from "./url-guard";

type SearchParams = Record<string, string | string[] | undefined>;

type ShipmentAmendCancelPageProps = {
  appKey: "console" | "portal";
  appBasePath: string;
  baseHref: string;
  searchParams: SearchParams;
  testIdPrefix: string;
};

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function firstValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function normalizeOptions(value: Record<string, unknown> | null): ShipmentAmendCancelOptions {
  return (value ?? {}) as unknown as ShipmentAmendCancelOptions;
}

function normalizeCurrentValues(value: Record<string, unknown> | null): ShipmentCurrentValues {
  return {
    trackingNumber: stringValue(value?.tracking_number),
    status: stringValue(value?.status),
    promisedDeliveryDate: stringValue(value?.promised_delivery_date),
    serviceType: stringValue(value?.service_type),
    serviceLevel: stringValue(value?.service_level),
    specialInstructions: stringValue(value?.special_instructions),
    clientReferenceNumber: stringValue(value?.client_reference_number),
    carrierReferenceNumber: stringValue(value?.carrier_reference_number),
    codAmount:
      typeof value?.cod_amount === "number" || typeof value?.cod_amount === "string"
        ? String(value.cod_amount)
        : null,
    addressLine1: stringValue(value?.address_line1),
    addressLine2: stringValue(value?.address_line2),
    addressCity: stringValue(value?.address_city),
    addressProvince: stringValue(value?.address_province),
    addressCountry: stringValue(value?.address_country),
    addressPostalCode: stringValue(value?.address_postal_code),
    addressDistrict: stringValue(value?.address_district),
    addressBuildingNumber: stringValue(value?.address_building_number),
    addressAdditionalDirections: stringValue(value?.address_additional_directions),
  };
}

function trimOrNull(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function parseOptionalJson(value: string | null) {
  if (!value) return null;
  return JSON.parse(value) as Record<string, unknown>;
}

function buildChanges(formData: FormData) {
  const changes: Record<string, unknown> = {};
  const serviceType = trimOrNull(formData.get("service_type"));
  const serviceLevel = trimOrNull(formData.get("service_level"));
  const clientReferenceNumber = trimOrNull(formData.get("client_reference_number"));
  const carrierReferenceNumber = trimOrNull(formData.get("carrier_reference_number"));
  const specialInstructions = trimOrNull(formData.get("special_instructions"));
  const codAmount = trimOrNull(formData.get("cod_amount"));
  const metadataJson = trimOrNull(formData.get("metadata_json"));
  const referencesJson = trimOrNull(formData.get("references_json"));

  if (serviceType) changes.service_type = serviceType;
  if (serviceLevel) changes.service_level = serviceLevel;
  if (clientReferenceNumber) changes.client_reference_number = clientReferenceNumber;
  if (carrierReferenceNumber) changes.carrier_reference_number = carrierReferenceNumber;
  if (specialInstructions) changes.special_instructions = specialInstructions;
  if (codAmount) changes.cod_amount = codAmount;
  if (metadataJson) changes.metadata = parseOptionalJson(metadataJson);
  if (referencesJson) changes.references = parseOptionalJson(referencesJson);

  return changes;
}

function buildAddress(formData: FormData) {
  const address: Record<string, unknown> = {};
  const line1 = trimOrNull(formData.get("line1"));
  const line2 = trimOrNull(formData.get("line2"));
  const city = trimOrNull(formData.get("city"));
  const province = trimOrNull(formData.get("province"));
  const country = trimOrNull(formData.get("country"));
  const postalCode = trimOrNull(formData.get("postal_code"));
  const district = trimOrNull(formData.get("district"));
  const buildingNumber = trimOrNull(formData.get("building_number"));
  const rawInput = trimOrNull(formData.get("raw_input"));
  const additionalDirections = trimOrNull(formData.get("additional_directions"));

  if (line1) address.line1 = line1;
  if (line2) address.line2 = line2;
  if (city) address.city = city;
  if (province) address.province = province;
  if (country) address.country = country;
  if (postalCode) address.postal_code = postalCode;
  if (district) address.district = district;
  if (buildingNumber) address.building_number = buildingNumber;
  if (rawInput) address.raw_input = rawInput;
  if (additionalDirections) address.additional_directions = additionalDirections;

  return address;
}

function createShipmentAmendCancelClient() {
  return createServerClient({ allowCookieSet: false }).schema("api");
}

function messageForOperation(operation: string, payload: Record<string, unknown> | null) {
  if (payload?.already_processed === true) return "Shipment change was already processed.";
  const workflowStatus = stringValue(payload?.workflow_status);
  const workflowRunId = stringValue(payload?.workflow_run_id);
  if (workflowStatus === "completed") {
    if (operation === "modify") return "Shipment modify completed.";
    if (operation === "reschedule") return "Shipment reschedule completed.";
    if (operation === "address") return "Shipment address update completed.";
    if (operation === "cancel") return "Shipment soft-cancel completed.";
  }
  if (workflowRunId) {
    return `Shipment change queued in workflow run ${workflowRunId}.`;
  }
  return "Shipment change submitted.";
}

export async function ShipmentAmendCancelPage({
  appKey,
  appBasePath,
  baseHref,
  searchParams,
  testIdPrefix,
}: ShipmentAmendCancelPageProps) {
  const shipmentId = firstValue(searchParams.shipment_id)?.trim() ?? "";
  const shipmentsHref = resolveSafeHref(appBasePath, "/resources/shipments");

  async function submitShipmentChange(
    _prevState: ShipmentAmendCancelState,
    formData: FormData,
  ): Promise<ShipmentAmendCancelState> {
    "use server";

    const actionShipmentId = String(formData.get("shipment_id") ?? "").trim();
    const operation = String(formData.get("operation") ?? "").trim().toLowerCase();

    if (!uuidRegex.test(actionShipmentId)) {
      return { status: "error", message: "Choose a valid shipment." };
    }

    try {
      const client = createShipmentAmendCancelClient();
      const input: Record<string, unknown> = {
        shipment_id: actionShipmentId,
        operation,
        surface: appKey,
      };

      if (operation === "modify") {
        const changes = buildChanges(formData);
        if (Object.keys(changes).length === 0) {
          return { status: "error", message: "Enter at least one field to modify." };
        }
        input.changes = changes;
      } else if (operation === "reschedule") {
        const slotDate = trimOrNull(formData.get("slot_date"));
        if (!slotDate) {
          return { status: "error", message: "Choose a promised delivery date." };
        }
        input.slot_date = slotDate;
      } else if (operation === "address") {
        const address = buildAddress(formData);
        if (!stringValue(address.line1) || !stringValue(address.city) || !stringValue(address.country)) {
          return {
            status: "error",
            message: "Address line 1, city, and country are required.",
          };
        }
        input.address = address;
      } else if (operation === "cancel") {
        input.reason = trimOrNull(formData.get("cancel_reason"));
      } else {
        return { status: "error", message: "Choose a valid shipment operation." };
      }

      const { data, error } = await client.rpc("shipment_amend_cancel_v1", {
        p_input: input,
      });

      if (error) {
        return {
          status: "error",
          message: formatUiError(error, "Shipment amend/cancel failed."),
        };
      }

      const payload = recordValue(data);
      const responseError = recordValue(payload?.error);
      if (payload?.ok === false || responseError) {
        return {
          status: "error",
          message:
            stringValue(responseError?.message) ||
            stringValue(responseError?.code) ||
            "Shipment amend/cancel failed.",
        };
      }

      revalidatePath(baseHref);
      return {
        status: "success",
        message: messageForOperation(operation, payload),
      };
    } catch (error) {
      return {
        status: "error",
        message: formatUiError(error, "Shipment amend/cancel failed."),
      };
    }
  }

  if (!uuidRegex.test(shipmentId)) {
    return (
      <PageContainer className="space-y-6">
        <PageHeader
          title="Shipment amend / cancel"
          description="Select a shipment first, then run one authenticated amend or soft-cancel operation through the workflow engine."
        />
        <ContextNotice
          title="Shipment id is required."
          action="Open a shipment and pass its `shipment_id` to this workspace."
          detail="This workflow-backed page only runs against a single shipment at a time."
          links={
            shipmentsHref
              ? [{ href: shipmentsHref, label: "Open shipments" }]
              : null
          }
          testId={`${testIdPrefix}-missing-shipment`}
        />
      </PageContainer>
    );
  }

  const client = createShipmentAmendCancelClient();
  const { data, error } = await client.rpc("shipment_amend_cancel_options_v1", {
    p_shipment_id: shipmentId,
  });

  if (error) {
    return (
      <PageContainer className="space-y-6">
        <PageHeader
          title="Shipment amend / cancel"
          description="Authenticated shipment change operations for console and portal."
        />
        <ContextNotice
          title="Unable to load shipment amend/cancel options."
          action="Check shipment access and retry."
          detail={formatUiError(error, "Shipment amend/cancel options are unavailable.")}
          links={
            shipmentsHref
              ? [{ href: shipmentsHref, label: "Back to shipments" }]
              : null
          }
          testId={`${testIdPrefix}-load-error`}
        />
      </PageContainer>
    );
  }

  const payload = recordValue(data);
  const options = normalizeOptions(payload);
  const currentValues = normalizeCurrentValues(recordValue(payload?.current_values));
  const trackingNumber = currentValues.trackingNumber ?? shipmentId;

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Shipment amend / cancel"
        description="Submit one authenticated shipment mutation. The engine stays canonical and the temporary lock comes only from shipment_operation_policy."
        eyebrow={trackingNumber}
        actions={
          shipmentsHref ? (
            <Button asChild variant="soft" size="sm">
              <a href={shipmentsHref}>Back to shipments</a>
            </Button>
          ) : null
        }
      />
      <Section
        title="Execution"
        description="Each action starts a real workflow run and attempts a bounded inline kick for immediate feedback."
        collapsible
        collapseKey="shipment-amend-cancel.execution"
      >
        <ShipmentAmendCancelForm
          action={submitShipmentChange}
          shipmentId={shipmentId}
          options={options}
          currentValues={currentValues}
          testIdPrefix={testIdPrefix}
        />
      </Section>
    </PageContainer>
  );
}
