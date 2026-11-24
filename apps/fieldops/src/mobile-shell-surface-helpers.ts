import type {
  MobileAddressPolicy,
  MobileCommunicationPolicy,
  MobilePlatform,
} from "./mobile-shell-policy";

type JsonRecord = Record<string, unknown>;

export function formatMoneyLabel(amount: number | null, currency: string | null | undefined) {
  if (amount == null || !Number.isFinite(amount)) return null;
  const code = currency ?? "SAR";
  const decimals = /^[a-z]{3}$/i.test(code) && typeof Intl !== "undefined" && typeof Intl.NumberFormat === "function"
    ? new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2
    : 2;
  const scale = 10 ** decimals;
  return `${code} ${Math.round(amount * scale) / scale}`;
}

export type SurfaceCoordinates = {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
};

export type AddressFieldSnapshot = {
  key: string;
  label: string;
  value: string;
  required: boolean;
  missing: boolean;
};

export type SettlementSnapshot = {
  id: string;
  title: string;
  status: string;
  currency: string;
  expected: number | null;
  counted: number | null;
  variance: number | null;
  windowStartAt: string | null;
  windowEndAt: string | null;
};

export type RouteCardSnapshot = {
  title: string;
  customerName: string | null;
  reference: string | null;
  sequence: number | null;
  kind: string | null;
  etaMin: number | null;
  place: string | null;
  status: string | null;
  statusReason: string | null;
  packageCount: number | null;
  codBadge: string | null;
};

export type TaskCardSnapshot = {
  title: string;
  customerName: string | null;
  reference: string | null;
  place: string | null;
  status: string;
  statusReason: string | null;
  priority: string | null;
  due: string | null;
  packageCount: number | null;
  codBadge: string | null;
};

export type OperationalStopSnapshot = {
  title: string;
  customerName: string | null;
  phone: string | null;
  reference: string | null;
  sequence: number | null;
  kind: string | null;
  status: string;
  statusReason: string | null;
  etaMin: number | null;
  due: string | null;
  priority: string | null;
  place: string | null;
  addressSummary: string | null;
  fullAddress: string | null;
  notes: string | null;
  packageCount: number | null;
  codAmount: number | null;
  expectedAmount: number | null;
  currency: string | null;
  collectionRequired: boolean | null;
  collectionOutcome: string | null;
  collectedAmount: number | null;
  varianceAmount: number | null;
  discrepancyKind: string | null;
  hasDiscrepancy: boolean | null;
  receiptContext: string | null;
  proofArtifactCount: number | null;
  signatureArtifactId: string | null;
  proofArtifactIds: string[];
  paymentModeLabel: string | null;
  allowedMethods: string[];
  recipientMissing: boolean;
  phoneMissing: boolean;
  addressMissing: boolean;
};

export type OperationalContactTarget = {
  id: string;
  source: "customer" | "task_context" | "policy";
  role: string;
  label: string;
  name: string | null;
  phone: string | null;
  allowedChannels: string[];
  notes: string | null;
};

export type OperationalContactsSnapshot = {
  customer: OperationalContactTarget | null;
  supportContacts: OperationalContactTarget[];
};

export type ScanContextSnapshot = {
  label: string;
  resourceId: string | null;
  taskId: string | null;
  routeRunId: string | null;
  routeStopId: string | null;
  shipmentId: string | null;
  clientId: string | null;
  opsSessionId: string | null;
  reference: string | null;
  customerName: string | null;
};

export type FieldOpsActiveRoleOption = {
  roleId: string;
  roleKey: string;
  label: string;
  branchIds: string[];
};

export type FieldOpsActiveRoleSnapshot = {
  deviceId: string | null;
  selectionState: "selected" | "single_eligible" | "absent";
  selectedRole: FieldOpsActiveRoleOption | null;
  eligibleRoles: FieldOpsActiveRoleOption[];
};
function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizePhoneForWhatsApp(phone: string) {
  const digits = phone.replace(/[^0-9+]/g, "").replace(/^\+/, "");
  return digits || null;
}

function normalizeUniqueChannels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = value
    .map((entry) => toText(entry))
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.toLowerCase());
  return Array.from(new Set(out));
}

function toText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return null;
}

function toTextArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => toText(entry))
      .filter((entry): entry is string => Boolean(entry));
  }
  const text = toText(value);
  return text ? [text] : [];
}

export function extractFieldOpsActiveRoleSnapshot(
  value: unknown
): FieldOpsActiveRoleSnapshot {
  const record = asRecord(value);
  const eligibleRoles = (Array.isArray(record.eligible_roles)
    ? record.eligible_roles
    : []
  ).flatMap((entry): FieldOpsActiveRoleOption[] => {
    const role = asRecord(entry);
    const roleId = toText(role.role_id);
    const roleKey = toText(role.role_key);
    if (!roleId || !roleKey) return [];
    const branchIds = Array.from(
      new Set(
        (Array.isArray(role.branch_ids) ? role.branch_ids : [])
          .map((branchId) => toText(branchId))
          .filter((branchId): branchId is string => Boolean(branchId))
      )
    );
    return [{
      roleId,
      roleKey,
      label: toText(role.label) ?? roleKey,
      branchIds,
    }];
  });
  const selectedRoleId = toText(record.selected_role_id);
  const selectedRole = selectedRoleId
    ? eligibleRoles.find((role) => role.roleId === selectedRoleId) ?? null
    : null;
  const reportedState = toText(record.selection_state);
  const selectionState =
    selectedRole
      ? "selected"
      : reportedState === "single_eligible" && eligibleRoles.length === 1
        ? "single_eligible"
        : "absent";
  return {
    deviceId: toText(record.device_id),
    selectionState,
    selectedRole,
    eligibleRoles,
  };
}
function formatIntegerCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.round(value);
    return rounded >= 0 ? rounded : null;
  }
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      const rounded = Math.round(parsed);
      return rounded >= 0 ? rounded : null;
    }
  }
  return null;
}

function getNormalizedMatch(record: JsonRecord, key: string): unknown {
  const target = normalizeKey(key);
  for (const [candidateKey, candidateValue] of Object.entries(record)) {
    if (normalizeKey(candidateKey) === target) return candidateValue;
  }
  return undefined;
}

function pickAnyText(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = toText(getNormalizedMatch(record, key));
    if (candidate) return candidate;
  }
  return null;
}

function pickAnyNumber(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const candidate = toNumber(getNormalizedMatch(record, key));
    if (candidate != null) return candidate;
  }
  return null;
}

function pickAnyBoolean(record: JsonRecord, keys: string[]): boolean | null {
  for (const key of keys) {
    const candidate = toBoolean(getNormalizedMatch(record, key));
    if (candidate != null) return candidate;
  }
  return null;
}

function pickAnyTextArray(record: JsonRecord, keys: string[]): string[] {
  for (const key of keys) {
    const candidate = toTextArray(getNormalizedMatch(record, key));
    if (candidate.length > 0) return candidate;
  }
  return [];
}

function pickAnyTextFromRecords(records: JsonRecord[], keys: string[]): string | null {
  for (const record of records) {
    const candidate = pickAnyText(record, keys);
    if (candidate) return candidate;
  }
  return null;
}

function pickAnyNumberFromRecords(records: JsonRecord[], keys: string[]): number | null {
  for (const record of records) {
    const candidate = pickAnyNumber(record, keys);
    if (candidate != null) return candidate;
  }
  return null;
}

function pickAnyBooleanFromRecords(records: JsonRecord[], keys: string[]): boolean | null {
  for (const record of records) {
    const candidate = pickAnyBoolean(record, keys);
    if (candidate != null) return candidate;
  }
  return null;
}

function pickAnyTextArrayFromRecords(records: JsonRecord[], keys: string[]): string[] {
  for (const record of records) {
    const candidate = pickAnyTextArray(record, keys);
    if (candidate.length > 0) return candidate;
  }
  return [];
}

function pickAnyCount(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const candidate = formatIntegerCount(getNormalizedMatch(record, key));
    if (candidate != null) return candidate;
  }
  return null;
}

function pickAnyCountFromRecords(records: JsonRecord[], keys: string[]): number | null {
  for (const record of records) {
    const candidate = pickAnyCount(record, keys);
    if (candidate != null) return candidate;
  }
  return null;
}

function normalizeContactTarget(
  value: unknown,
  source: OperationalContactTarget["source"],
  fallbackChannels: string[]
): OperationalContactTarget | null {
  const contact = asRecord(value);
  const role = pickAnyText(contact, ["role", "type"]) ?? (source === "policy" ? "support" : "dispatcher");
  const name = pickAnyText(contact, ["name", "contact_name"]);
  const phone = pickAnyText(contact, ["phone_number", "phone", "mobile"]);
  if (!phone) return null;
  const label = pickAnyText(contact, ["label", "title"]) ?? name ?? role;
  const id =
    pickAnyText(contact, ["id", "key"]) ??
    [source, role, phone ?? label].filter(Boolean).join(":");
  const allowedChannels = normalizeUniqueChannels(getNormalizedMatch(contact, "allowed_channels"));
  const notes = pickAnyText(contact, ["notes", "description"]);

  return {
    id,
    source,
    role,
    label,
    name,
    phone,
    allowedChannels: allowedChannels.length ? allowedChannels : fallbackChannels,
    notes,
  };
}

function collectContactTargets(
  rawValues: unknown[],
  source: OperationalContactTarget["source"],
  fallbackChannels: string[]
): OperationalContactTarget[] {
  const out: OperationalContactTarget[] = [];
  const seen = new Set<string>();

  for (const rawValue of rawValues) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      const next = normalizeContactTarget(value, source, fallbackChannels);
      if (!next) continue;
      const dedupeKey = `${next.role}:${next.phone ?? next.label}`.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(next);
    }
  }

  return out;
}

function candidateRecords(detail: JsonRecord): JsonRecord[] {
  const metadata = asRecord(detail.metadata);
  const payload = asRecord(detail.payload);
  const address = asRecord(detail.address);
  const customer = asRecord(detail.customer);
  const contact = asRecord(detail.contact);
  const location = asRecord(detail.location);
  const routeStop = asRecord(detail.route_stop);
  const routeStopPayment = asRecord(routeStop.payment);
  const metadataAddress = asRecord(metadata.address);
  const metadataCustomer = asRecord(metadata.customer);
  const metadataContact = asRecord(metadata.contact);
  const metadataLocation = asRecord(metadata.location);
  const metadataPayment = asRecord(metadata.payment);
  const metadataSettlement = asRecord(metadata.settlement);
  const metadataRouteStop = asRecord(metadata.route_stop);
  const metadataRouteStopPayment = asRecord(metadataRouteStop.payment);
  const payloadAddress = asRecord(payload.address);
  const payloadCustomer = asRecord(payload.customer);
  const payloadContact = asRecord(payload.contact);
  const payloadLocation = asRecord(payload.location);
  const payloadPayment = asRecord(payload.payment);
  const payloadSettlement = asRecord(payload.settlement);
  const payloadRouteStop = asRecord(payload.route_stop);
  const payloadRouteStopPayment = asRecord(payloadRouteStop.payment);
  const payment = asRecord(detail.payment);
  const settlement = asRecord(detail.settlement);

  return [
    detail,
    metadata,
    payload,
    routeStop,
    routeStopPayment,
    metadataRouteStop,
    metadataRouteStopPayment,
    payloadRouteStop,
    payloadRouteStopPayment,
    address,
    metadataAddress,
    payloadAddress,
    customer,
    metadataCustomer,
    payloadCustomer,
    contact,
    metadataContact,
    payloadContact,
    payment,
    metadataPayment,
    payloadPayment,
    settlement,
    metadataSettlement,
    payloadSettlement,
    location,
    metadataLocation,
    payloadLocation,
  ];
}

function paymentCollectionRecords(detail: JsonRecord): JsonRecord[] {
  const metadata = asRecord(detail.metadata);
  const payload = asRecord(detail.payload);
  const routeStop = asRecord(detail.route_stop);
  const metadataRouteStop = asRecord(metadata.route_stop);
  const payloadRouteStop = asRecord(payload.route_stop);
  const deliveryCompletion = asRecord(detail.delivery_completion);
  const metadataDeliveryCompletion = asRecord(metadata.delivery_completion);
  const payloadDeliveryCompletion = asRecord(payload.delivery_completion);
  const routeStopDeliveryCompletion = asRecord(routeStop.delivery_completion);
  const metadataRouteStopDeliveryCompletion = asRecord(metadataRouteStop.delivery_completion);
  const payloadRouteStopDeliveryCompletion = asRecord(payloadRouteStop.delivery_completion);
  const actionData = asRecord(detail.action_data);
  const actionDataDeliveryCompletion = asRecord(actionData.delivery_completion);
  const actionDataTaskEventPayload = asRecord(actionData.task_event_payload);
  const actionDataTaskDeliveryCompletion = asRecord(actionDataTaskEventPayload.delivery_completion);
  const shipmentAction = asRecord(detail.shipment_action);
  const shipmentActionData = asRecord(shipmentAction.action_data);
  const shipmentActionDeliveryCompletion = asRecord(shipmentActionData.delivery_completion);
  const shipmentActionTaskEventPayload = asRecord(shipmentActionData.task_event_payload);
  const shipmentActionTaskDeliveryCompletion = asRecord(
    shipmentActionTaskEventPayload.delivery_completion
  );

  return [
    asRecord(detail.payment_collection),
    asRecord(routeStopDeliveryCompletion.payment_collection),
    asRecord(metadataRouteStopDeliveryCompletion.payment_collection),
    asRecord(payloadRouteStopDeliveryCompletion.payment_collection),
    asRecord(deliveryCompletion.payment_collection),
    asRecord(metadataDeliveryCompletion.payment_collection),
    asRecord(payloadDeliveryCompletion.payment_collection),
    asRecord(actionData.payment_collection),
    asRecord(actionDataDeliveryCompletion.payment_collection),
    asRecord(actionDataTaskEventPayload.payment_collection),
    asRecord(actionDataTaskDeliveryCompletion.payment_collection),
    asRecord(shipmentActionData.payment_collection),
    asRecord(shipmentActionDeliveryCompletion.payment_collection),
    asRecord(shipmentActionTaskEventPayload.payment_collection),
    asRecord(shipmentActionTaskDeliveryCompletion.payment_collection),
  ];
}

function paymentProjectionRecords(detail: JsonRecord): JsonRecord[] {
  return [detail, asRecord(detail.shipment_action)];
}

function formatAddressLine(parts: Array<string | null | undefined>): string | null {
  const filtered = parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean);
  return filtered.length ? filtered.join(", ") : null;
}

function formatShortPlace(parts: Array<string | null | undefined>): string | null {
  const filtered = parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean);
  return filtered.length ? filtered.join(" - ") : null;
}

const SAUDI_SHORT_ADDRESS_KEYS = [
  "short_address",
  "shortAddress",
  "address_short",
  "sa_short_code",
  "short_national_address",
  "shortNationalAddress",
  "national_short_address",
  "nationalShortAddress",
  "short_code",
  "shortCode",
  "national_address_short_code",
  "nationalAddressShortCode",
];

function formatAddressRecord(record: JsonRecord): string | null {
  const street = pickAnyText(record, ["street", "address_line_1", "line1", "street_name"]);
  const building = pickAnyText(record, [
    "building_no",
    "building_number",
    "buildingno",
    "building",
    "house_no",
  ]);
  const district = pickAnyText(record, ["district", "neighborhood", "area"]);
  const city = pickAnyText(record, ["city", "destination_city"]);
  const postalCode = pickAnyText(record, ["postal_code", "postcode", "zip", "zip_code"]);
  const shortAddress = pickAnyText(record, SAUDI_SHORT_ADDRESS_KEYS);

  const streetLine =
    street && building ? `${street} ${building}` : street ?? (building ? `Building ${building}` : null);

  return (
    formatAddressLine([streetLine, district, city, postalCode, shortAddress]) ??
    formatShortPlace([district, city, shortAddress])
  );
}

function extractAddressSummaryFromRecords(records: JsonRecord[]): {
  locality: string | null;
  fullAddress: string | null;
} {
  for (const record of records) {
    const locality = formatShortPlace([
      pickAnyText(record, ["district", "neighborhood", "area"]),
      pickAnyText(record, ["city", "destination_city"]),
      pickAnyText(record, SAUDI_SHORT_ADDRESS_KEYS),
    ]);
    const fullAddress = formatAddressRecord(record);
    if (locality || fullAddress) {
      return { locality, fullAddress };
    }
  }
  return { locality: null, fullAddress: null };
}

export function extractCoordinates(detailValue: unknown): SurfaceCoordinates | null {
  const detail = asRecord(detailValue);
  const records = candidateRecords(detail);
  const latitude = pickAnyNumberFromRecords(records, [
    "latitude",
    "lat",
    "destination_latitude",
    "pickup_latitude",
    "dest_latitude",
  ]);
  const longitude = pickAnyNumberFromRecords(records, [
    "longitude",
    "lng",
    "lon",
    "destination_longitude",
    "pickup_longitude",
    "dest_longitude",
  ]);
  const accuracyM = pickAnyNumberFromRecords(records, [
    "accuracy",
    "accuracy_m",
    "location_accuracy_m",
    "gps_accuracy_m",
  ]);

  if (latitude == null || longitude == null) return null;
  return { latitude, longitude, accuracyM };
}

export function extractPhoneNumber(detailValue: unknown): string | null {
  const detail = asRecord(detailValue);
  const records = candidateRecords(detail);
  for (const record of records) {
    const phone = pickAnyText(record, ["phone", "phone_number", "customer_phone", "mobile"]);
    if (phone) return phone;
  }
  return null;
}

export function extractCustomerName(detailValue: unknown): string {
  const detail = asRecord(detailValue);
  const records = candidateRecords(detail);
  for (const record of records) {
    const name = pickAnyText(record, ["customer_name", "name", "customer"]);
    if (name) return name;
  }
  return "Customer";
}

export function extractAddressFields(
  detailValue: unknown,
  addressPolicy: MobileAddressPolicy
): AddressFieldSnapshot[] {
  const detail = asRecord(detailValue);
  const records = candidateRecords(detail);

  return addressPolicy.fields.map((field) => {
    let value: string | null = null;
    for (const record of records) {
      const match = getNormalizedMatch(record, field.key);
      value =
        toText(match) ??
        (field.key.trim().toLowerCase() === "address" ? formatAddressRecord(asRecord(match)) : null);
      if (value) break;
    }

    if (!value && field.key.trim().toLowerCase() === "address") {
      value = extractAddressSummaryFromRecords(records).fullAddress;
    }

    return {
      key: field.key,
      label: field.label,
      value: value ?? "-",
      required: field.required,
      missing: field.required && !value,
    };
  });
}

export function extractSettlementSnapshot(
  detailValue: unknown,
  fallbackId: string
): SettlementSnapshot {
  const detail = asRecord(detailValue);
  const metadata = asRecord(detail.metadata);
  const payload = asRecord(detail.payload);
  const settlement = asRecord(detail.settlement);
  const paymentSummaryRecords = [
    asRecord(settlement.payment_collection_summary),
    asRecord(metadata.payment_collection_summary),
    asRecord(payload.payment_collection_summary),
  ];
  const hasPaymentSummary = paymentSummaryRecords.some((record) => Object.keys(record).length > 0);
  const genericRecords = candidateRecords(detail);
  const records = [...paymentSummaryRecords, ...genericRecords];
  const expected = pickAnyNumberFromRecords(records, [
    "expected",
    "expected_amount",
    "expected_sar",
    "cash_expected",
    "total_expected",
  ]);
  const counted = pickAnyNumberFromRecords(records, [
    "counted",
    "counted_amount",
    "counted_sar",
    "cash_counted",
    "total_counted",
    "collected_amount",
    "total_collected",
  ]);
  const explicitVariance = pickAnyNumberFromRecords(hasPaymentSummary ? genericRecords : records, [
    "variance",
    "variance_amount",
    "difference",
  ]);

  const variance =
    hasPaymentSummary && expected != null && counted != null
      ? counted - expected
      : explicitVariance != null
      ? explicitVariance
      : expected != null && counted != null
        ? counted - expected
        : null;

  const id =
    pickAnyTextFromRecords(records, ["id", "settlement_id", "batch_id"]) ?? fallbackId;
  const title =
    pickAnyTextFromRecords(records, ["title", "name", "label"]) ?? `Settlement ${id}`;
  const status = pickAnyTextFromRecords(records, ["status", "state"]) ?? "open";
  const currency = pickAnyTextFromRecords(records, ["currency", "currency_code"]) ?? "SAR";

  return {
    id,
    title,
    status,
    currency,
    expected,
    counted,
    variance,
    windowStartAt: typeof detail.window_start_at === "string" ? detail.window_start_at.trim() || null : null,
    windowEndAt: typeof detail.window_end_at === "string" ? detail.window_end_at.trim() || null : null,
  };
}

export function extractOperationalStopSnapshot(detailValue: unknown): OperationalStopSnapshot {
  const detail = asRecord(detailValue);
  const records = candidateRecords(detail);
  const paymentRecords = paymentCollectionRecords(detail);
  const paymentProjection = paymentProjectionRecords(detail);
  const paymentFallbackRecords = [
    asRecord(asRecord(detail.metadata).payment_collection),
    asRecord(asRecord(detail.payload).payment_collection),
  ];
  const paymentRecordsWithFallback = [...paymentRecords, ...paymentFallbackRecords];
  const addressSummary = extractAddressSummaryFromRecords(records);
  const customerName =
    pickAnyTextFromRecords(records, ["customer_name", "name", "customer"]) ?? null;
  const phone =
    pickAnyTextFromRecords(records, ["phone", "phone_number", "customer_phone", "mobile"]) ?? null;
  const sequence = pickAnyNumberFromRecords(records, [
    "sequence",
    "stop_sequence",
    "route_sequence",
    "order",
    "stop_order",
  ]);
  const etaMin = pickAnyNumberFromRecords(records, [
    "eta_min",
    "eta_minutes",
    "eta",
    "sla_minutes",
  ]);
  const kind = pickAnyTextFromRecords(records, ["kind", "stop_kind", "task_type", "type", "type_key"]);
  const status = pickAnyTextFromRecords(records, ["status", "state"]) ?? "open";
  const statusReason = pickAnyTextFromRecords(records, ["status_reason", "reason"]);
  const reference = pickAnyTextFromRecords(records, [
    "ref",
    "reference",
    "reference_number",
    "order_number",
    "shipment_ref",
    "shipment_number",
  ]);
  const notes = pickAnyTextFromRecords(records, [
    "notes",
    "note",
    "instructions",
    "delivery_instructions",
    "stop_notes",
    "customer_notes",
  ]);
  const title =
    pickAnyTextFromRecords(records, ["title", "label", "name", "task_label"]) ??
    (reference ? `Stop ${reference}` : "Task");
  const priorityNumber = pickAnyNumberFromRecords(records, ["priority", "priority_score"]);
  const priorityText = pickAnyTextFromRecords(records, ["priority_label", "priority_code"]);
  const dueText = pickAnyTextFromRecords(records, ["due", "due_label", "sla_label"]);
  const due =
    dueText ??
    (etaMin != null && Number.isFinite(etaMin) ? `Due ${Math.round(etaMin)}m` : null);
  const priority =
    priorityText ??
    (priorityNumber != null
      ? priorityNumber >= 0 && priorityNumber <= 100
        ? `P${Math.round(priorityNumber)}`
        : String(Math.round(priorityNumber))
      : null);
  const packageCount = pickAnyCountFromRecords(records, [
    "package_count",
    "packages_count",
    "parcel_count",
    "shipment_count",
    "handling_unit_count",
    "packages",
    "parcels",
  ]);
  const paymentExpectedAmount =
    pickAnyNumberFromRecords(paymentRecords, ["expected_amount"]) ??
    pickAnyNumberFromRecords(paymentProjection, ["payment_expected_amount"]);
  const codAmount =
    paymentExpectedAmount ??
    pickAnyNumberFromRecords(records, [
      "cod_amount",
      "expected_amount",
      "cash_on_delivery_amount",
      "amount_due",
      "amount_to_collect",
      "collection_amount",
    ]) ??
    pickAnyNumberFromRecords(paymentFallbackRecords, ["expected_amount"]);
  const expectedAmount =
    paymentExpectedAmount ??
    pickAnyNumberFromRecords(records, [
      "expected_amount",
      "cod_amount",
      "cash_on_delivery_amount",
      "amount_due",
      "amount_to_collect",
      "collection_amount",
    ]) ??
    pickAnyNumberFromRecords(paymentFallbackRecords, ["expected_amount"]);
  const collectedAmount =
    pickAnyNumberFromRecords(paymentRecords, ["collected_amount"]) ??
    pickAnyNumberFromRecords(paymentProjection, ["payment_collected_amount"]) ??
    pickAnyNumberFromRecords(paymentFallbackRecords, ["collected_amount"]) ??
    pickAnyNumberFromRecords(paymentRecordsWithFallback, ["cash_collected", "amount_collected"]);
  const varianceAmount =
    pickAnyNumberFromRecords(paymentRecords, ["variance_amount"]) ??
    pickAnyNumberFromRecords(paymentProjection, ["payment_variance_amount"]) ??
    pickAnyNumberFromRecords(paymentFallbackRecords, ["variance_amount"]);
  const currency =
    pickAnyTextFromRecords(paymentRecords, ["currency"]) ??
    pickAnyTextFromRecords(paymentProjection, ["payment_currency"]) ??
    pickAnyTextFromRecords(records, ["currency", "currency_code", "cod_currency"]) ??
    pickAnyTextFromRecords(paymentFallbackRecords, ["currency"]);
  const collectionRequired =
    pickAnyBooleanFromRecords(records, ["collection_required"]) ??
    (expectedAmount != null ? expectedAmount > 0 : codAmount != null ? codAmount > 0 : null);
  const collectionOutcome =
    pickAnyTextFromRecords(paymentRecords, ["outcome"]) ??
    pickAnyTextFromRecords(paymentProjection, ["payment_collection_outcome"]) ??
    pickAnyTextFromRecords(paymentFallbackRecords, ["outcome"]);
  const discrepancyKind =
    pickAnyTextFromRecords(paymentRecords, ["discrepancy_kind"]) ??
    pickAnyTextFromRecords(paymentProjection, ["payment_discrepancy_kind"]) ??
    pickAnyTextFromRecords(paymentFallbackRecords, ["discrepancy_kind"]);
  const hasDiscrepancy =
    pickAnyBooleanFromRecords(paymentRecords, ["has_discrepancy"]) ??
    pickAnyBooleanFromRecords(paymentProjection, ["payment_has_discrepancy"]) ??
    pickAnyBooleanFromRecords(paymentFallbackRecords, ["has_discrepancy"]);
  const receiptContext =
    pickAnyTextFromRecords(paymentRecords, ["receipt_context"]) ??
    pickAnyTextFromRecords(paymentProjection, ["payment_receipt_context"]) ??
    pickAnyTextFromRecords(paymentFallbackRecords, ["receipt_context"]) ??
    pickAnyTextFromRecords(paymentRecordsWithFallback, ["receipt_number"]);
  const proofArtifactIds = pickAnyTextArrayFromRecords(paymentRecordsWithFallback, [
    "proof_artifact_ids",
    "artifact_ids",
  ]);
  const proofArtifactCount =
    pickAnyCountFromRecords(paymentRecordsWithFallback, ["proof_artifact_count"]) ??
    (proofArtifactIds.length ? proofArtifactIds.length : null);
  const signatureArtifactId = pickAnyTextFromRecords(paymentRecordsWithFallback, ["signature_artifact_id"]);
  const paymentModeLabel =
    pickAnyTextFromRecords(paymentRecords, ["payment_mode_label", "method"]) ??
    pickAnyTextFromRecords(paymentProjection, ["payment_collection_method"]) ??
    pickAnyTextFromRecords(records, ["payment_mode_label"]) ??
    pickAnyTextFromRecords(paymentFallbackRecords, ["payment_mode_label", "method"]) ??
    pickAnyTextFromRecords(paymentRecordsWithFallback, ["payment_method"]);
  const canonicalAllowedMethods = pickAnyTextArrayFromRecords(
    [...paymentRecords, ...records, ...paymentFallbackRecords],
    ["allowed_methods"]
  );
  const allowedMethods = canonicalAllowedMethods.length
    ? canonicalAllowedMethods
    : pickAnyTextArrayFromRecords(paymentRecordsWithFallback, ["allowed_payment_methods"]);

  return {
    title,
    customerName,
    phone,
    reference,
    sequence,
    kind,
    status,
    statusReason,
    etaMin,
    due,
    priority,
    place: addressSummary.locality,
    addressSummary: addressSummary.locality,
    fullAddress: addressSummary.fullAddress,
    notes,
    packageCount,
    codAmount,
    expectedAmount,
    currency,
    collectionRequired,
    collectionOutcome,
    collectedAmount,
    varianceAmount,
    discrepancyKind,
    hasDiscrepancy,
    receiptContext,
    proofArtifactCount,
    signatureArtifactId,
    proofArtifactIds,
    paymentModeLabel,
    allowedMethods,
    recipientMissing: !customerName,
    phoneMissing: !phone,
    addressMissing: !addressSummary.fullAddress,
  };
}

export function extractOperationalContacts(
  detailValue: unknown,
  communicationPolicy?: MobileCommunicationPolicy | null
): OperationalContactsSnapshot {
  const detail = asRecord(detailValue);
  const metadata = asRecord(detail.metadata);
  const payload = asRecord(detail.payload);
  const fallbackChannels = communicationPolicy?.allowedChannels ?? ["call", "sms", "whatsapp"];
  const stop = extractOperationalStopSnapshot(detailValue);

  const customer =
    stop.customerName || stop.phone
      ? {
          id: `customer:${stop.phone ?? stop.customerName ?? "recipient"}`,
          source: "customer" as const,
          role: "customer",
          label: stop.customerName ?? "Customer",
          name: stop.customerName,
          phone: stop.phone,
          allowedChannels: fallbackChannels,
          notes: stop.notes,
        }
      : null;

  const taskContextContacts = collectContactTargets(
    [
      detail.support_contacts,
      metadata.support_contacts,
      payload.support_contacts,
      detail.dispatcher_contact,
      metadata.dispatcher_contact,
      payload.dispatcher_contact,
      detail.dispatcher_contacts,
      metadata.dispatcher_contacts,
      payload.dispatcher_contacts,
    ],
    "task_context",
    fallbackChannels
  );
  const policyContacts = collectContactTargets(
    communicationPolicy?.supportContacts ?? [],
    "policy",
    fallbackChannels
  );

  const supportContacts = [...taskContextContacts];
  const seen = new Set(
    taskContextContacts.map((contact) => `${contact.role}:${contact.phone ?? contact.label}`.toLowerCase())
  );
  for (const contact of policyContacts) {
    const dedupeKey = `${contact.role}:${contact.phone ?? contact.label}`.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    supportContacts.push(contact);
  }

  return {
    customer,
    supportContacts,
  };
}

export function extractScanContext(
  detailValue: unknown,
  fallbackResourceId?: string | null
): ScanContextSnapshot {
  const detail = asRecord(detailValue);
  const records = candidateRecords(detail);
  const operational = extractOperationalStopSnapshot(detailValue);
  const taskId = pickAnyTextFromRecords(records, ["task_id", "id"]) ?? fallbackResourceId ?? null;
  const routeRunId =
    pickAnyTextFromRecords(records, ["route_run_id"]) ??
    pickAnyText(asRecord(detail.route_stop), ["route_run_id"]) ??
    pickAnyText(asRecord(asRecord(detail.metadata).route_stop), ["route_run_id"]) ??
    pickAnyText(asRecord(asRecord(detail.payload).route_stop), ["route_run_id"]);
  const routeStopId =
    pickAnyTextFromRecords(records, ["route_stop_id"]) ??
    pickAnyText(asRecord(detail.route_stop), ["id"]) ??
    pickAnyText(asRecord(asRecord(detail.metadata).route_stop), ["id"]) ??
    pickAnyText(asRecord(asRecord(detail.payload).route_stop), ["id"]);
  const resourceType = pickAnyTextFromRecords(records, ["resource_type"]);
  const resourceId = pickAnyTextFromRecords(records, ["id", "resource_id"]) ?? fallbackResourceId ?? null;
  const shipmentId =
    pickAnyTextFromRecords(records, ["shipment_id"]) ??
    (resourceType?.trim().toLowerCase() === "shipment"
      ? pickAnyTextFromRecords(records, ["resource_id"])
      : null);
  const clientId = pickAnyTextFromRecords(records, ["client_id"]);
  const opsSessionId = pickAnyTextFromRecords(records, ["ops_session_id"]);
  const label =
    operational.reference ??
    operational.customerName ??
    operational.title;

  return {
    label,
    resourceId,
    taskId,
    routeRunId,
    routeStopId,
    shipmentId,
    clientId,
    opsSessionId,
    reference: operational.reference,
    customerName: operational.customerName,
  };
}

export function extractRouteCardSnapshot(detailValue: unknown): RouteCardSnapshot {
  const stop = extractOperationalStopSnapshot(detailValue);
  const codLabel = formatMoneyLabel(stop.codAmount, stop.currency);

  return {
    title: stop.title,
    customerName: stop.customerName,
    reference: stop.reference,
    sequence: stop.sequence,
    kind: stop.kind,
    etaMin: stop.etaMin,
    place: stop.place,
    status: stop.status,
    statusReason: stop.statusReason,
    packageCount: stop.packageCount,
    codBadge: codLabel != null ? `${codLabel} COD` : null,
  };
}

export function extractTaskCardSnapshot(detailValue: unknown): TaskCardSnapshot {
  const stop = extractOperationalStopSnapshot(detailValue);
  const codLabel = formatMoneyLabel(stop.codAmount, stop.currency);

  return {
    title: stop.title,
    customerName: stop.customerName,
    reference: stop.reference,
    place: stop.place,
    status: stop.status,
    statusReason: stop.statusReason,
    priority: stop.priority,
    due: stop.due,
    packageCount: stop.packageCount,
    codBadge: codLabel != null ? `${codLabel} COD` : null,
  };
}

export function buildNavigationUrl(params: {
  provider: string;
  platform: MobilePlatform;
  latitude: number;
  longitude: number;
}): string {
  const provider = params.provider.trim().toLowerCase();
  const destination = `${params.latitude},${params.longitude}`;

  if (provider.includes("apple") && params.platform === "ios") {
    return `http://maps.apple.com/?daddr=${encodeURIComponent(destination)}`;
  }
  if (provider.includes("waze")) {
    return `https://waze.com/ul?ll=${encodeURIComponent(destination)}&navigate=yes`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    destination
  )}&travelmode=driving`;
}

export function buildChannelUrl(params: {
  channel: "call" | "sms" | "whatsapp";
  phone: string;
  message?: string;
}): string | null {
  const phone = params.phone.trim();
  if (!phone) return null;

  if (params.channel === "call") {
    return `tel:${phone}`;
  }

  if (params.channel === "sms") {
    const message = params.message?.trim() ?? "";
    if (!message) return `sms:${phone}`;
    return `sms:${phone}?body=${encodeURIComponent(message)}`;
  }

  const waPhone = normalizePhoneForWhatsApp(phone);
  if (!waPhone) return null;
  const message = params.message?.trim() ?? "";
  if (!message) return `https://wa.me/${waPhone}`;
  return `https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`;
}

export type FieldOpsLiveState = "absent" | "empty" | "ready" | "error";
export type FieldOpsLiveResourceKey =
  | "routes"
  | "route_stops"
  | "tasks"
  | "baskets"
  | "basket_items"
  | "return_to_branch_shipments";
export type FieldOpsLiveRpcKey = "pickup_failures_list_v1";

export type FieldOpsLiveResourceQuery = {
  id: string;
  resource: FieldOpsLiveResourceKey;
  filters: Record<string, unknown>;
};

export type FieldOpsLiveRpcQuery = {
  id: string;
  rpc: FieldOpsLiveRpcKey;
};

export type FieldOpsLiveSourceSelection = {
  roleKey: "loader" | "rider" | "supervisor" | null;
  state: "absent" | "ready";
  rpcQueries: FieldOpsLiveRpcQuery[];
  resourceQueries: FieldOpsLiveResourceQuery[];
  missingResourceKeys: FieldOpsLiveResourceKey[];
};

export type FieldOpsLiveSourceResult = {
  state: FieldOpsLiveState;
  rows: JsonRecord[];
  complete: boolean;
};

export type FieldOpsLiveOperationsSnapshot = {
  state: FieldOpsLiveState;
  work: {
    state: FieldOpsLiveState;
    visibleCount: number | null;
  };
  pickup: {
    state: FieldOpsLiveState;
    id: string | null;
    windowStartAt: string | null;
    windowEndAt: string | null;
    seal: string | null;
    expectedCount: number | null;
    pickedCount: number | null;
    failureCount: number | null;
  };
  trip: {
    state: FieldOpsLiveState;
    id: string | null;
    origin: string | null;
    destination: string | null;
    stage: string | null;
    plannedStartAt: string | null;
    plannedEndAt: string | null;
    startedAt: string | null;
    endedAt: string | null;
    eta: string | null;
    driverId: string | null;
    vehicleId: string | null;
    count: number | null;
    seal: string | null;
    manifest: unknown | null;
    context: JsonRecord | null;
  };
  sortation: {
    state: FieldOpsLiveState;
    bays: number | null;
    recent: number | null;
    inducted: number | null;
    throughput: number | null;
    minutes: number | null;
  };
};

const ROLE_KEY_MAP: Record<string, "loader" | "rider" | "supervisor"> = {
  driver: "rider",
  warehouse_operator: "loader",
  fleet_manager: "supervisor",
  rider: "rider",
  loader: "loader",
  supervisor: "supervisor",
};

const ROLE_QUERIES: Record<"loader" | "rider" | "supervisor", {
  rpcQueries: FieldOpsLiveRpcQuery[];
  resourceQueries: FieldOpsLiveResourceQuery[];
}> = {
  rider: {
    rpcQueries: [],
    resourceQueries: [
      { id: "routes", resource: "routes", filters: {} },
      { id: "routeStops", resource: "route_stops", filters: { stop_kind: "pickup" } },
    ],
  },
  loader: {
    rpcQueries: [],
    resourceQueries: [
      { id: "warehouseSortTasks", resource: "tasks", filters: { task_type_key: "warehouse_sort" } },
      { id: "baskets", resource: "baskets", filters: {} },
      { id: "basketItems", resource: "basket_items", filters: {} },
      { id: "returns", resource: "return_to_branch_shipments", filters: {} },
    ],
  },
  supervisor: {
    rpcQueries: [{ id: "pickupFailures", rpc: "pickup_failures_list_v1" }],
    resourceQueries: [
      { id: "warehouseSupervisorTasks", resource: "tasks", filters: { task_type_key: "warehouse_supervisor_approval" } },
      { id: "warehouseScanSupervisorTasks", resource: "tasks", filters: { task_type_key: "warehouse_scan_supervisor_approval" } },
      { id: "dispatchExceptionTasks", resource: "tasks", filters: { task_type_key: "dispatch_exception_review" } },
    ],
  },
};

export function selectFieldOpsLiveSources(
  roleValue: unknown,
  registryValue: unknown
): FieldOpsLiveSourceSelection {
  const normalizedRole = toText(roleValue)?.toLowerCase() ?? "";
  const roleKey = ROLE_KEY_MAP[normalizedRole] ?? null;
  if (!roleKey) {
    return { roleKey: null, state: "absent", rpcQueries: [], resourceQueries: [], missingResourceKeys: [] };
  }
  const configured = new Set(
    (Array.isArray(asRecord(registryValue).resources) ? asRecord(registryValue).resources as unknown[] : [])
      .map((entry) => toText(asRecord(entry).key))
      .filter((key): key is string => Boolean(key))
  );
  const plan = ROLE_QUERIES[roleKey];
  return {
    roleKey,
    state: "ready",
    rpcQueries: plan.rpcQueries,
    resourceQueries: plan.resourceQueries.filter((query) => configured.has(query.resource)),
    missingResourceKeys: Array.from(new Set(plan.resourceQueries
      .filter((query) => !configured.has(query.resource))
      .map((query) => query.resource))),
  };
}

export function fieldOpsLiveSourceResult(
  value: unknown,
  options: { error?: boolean; complete?: boolean } = {}
): FieldOpsLiveSourceResult {
  if (options.error) return { state: "error", rows: [], complete: false };
  if (value == null) return { state: "absent", rows: [], complete: false };
  const rows = (Array.isArray(value) ? value : [])
    .map(asRecord)
    .filter((row) => Object.keys(row).length > 0);
  return { state: rows.length ? "ready" : "empty", rows, complete: options.complete ?? true };
}

function liveFirst(records: JsonRecord[], keys: string[]): unknown {
  for (const record of records) {
    const candidates = [record, asRecord(record.metadata), asRecord(record.pickup_request),
      asRecord(record.pickup_wave), asRecord(record.route_execution_manifest)];
    for (const candidate of candidates) {
      for (const key of keys) if (candidate[key] !== null && candidate[key] !== undefined) return candidate[key];
    }
  }
  return null;
}

function liveState(sources: FieldOpsLiveSourceResult[]): FieldOpsLiveState {
  if (!sources.length || sources.every((source) => source.state === "absent")) return "absent";
  if (sources.some((source) => source.state === "error")) return "error";
  if (sources.every((source) => source.state === "empty" || source.state === "absent")) return "empty";
  return "ready";
}

export function projectFieldOpsLiveOperations(
  sources: Record<string, FieldOpsLiveSourceResult>
): FieldOpsLiveOperationsSnapshot {
  const pickupSources = [sources.routeStops].filter(Boolean) as FieldOpsLiveSourceResult[];
  const tripSources = [sources.routes].filter(Boolean) as FieldOpsLiveSourceResult[];
  const sortationSources = [sources.warehouseSortTasks, sources.baskets, sources.basketItems, sources.returns]
    .filter(Boolean) as FieldOpsLiveSourceResult[];
  const workSources = [sources.warehouseSortTasks, sources.warehouseSupervisorTasks,
    sources.warehouseScanSupervisorTasks, sources.dispatchExceptionTasks]
    .filter(Boolean) as FieldOpsLiveSourceResult[];
  const pickupRow = sources.routeStops?.rows.find((row) => toText(row.route_stop_id ?? row.id)) ?? null;
  const pickupRows = pickupRow ? [pickupRow] : [];
  const failureRows = sources.pickupFailures?.rows ?? [];
  const tripRow = sources.routes?.rows.find((row) => toText(row.route_run_id ?? row.id)) ?? null;
  const tripRows = tripRow ? [tripRow] : [];
  const plannedEndAt = toText(liveFirst(tripRows, ["planned_end_at"]));
  const pickupShipmentId = toText(liveFirst(pickupRows, ["shipment_id"]));
  const allSources = Object.values(sources);
  return {
    state: liveState(allSources),
    work: {
      state: liveState(workSources),
      visibleCount: workSources.length
        ? workSources.reduce((total, source) => total + source.rows.length, 0)
        : null,
    },
    pickup: {
      state: liveState(pickupSources),
      id: toText(liveFirst(pickupRows, ["route_stop_id", "id", "route_run_id"])),
      windowStartAt: toText(liveFirst(pickupRows, ["planned_window_start_at", "route_planned_start_at",
        "planned_start_at", "requested_window_start_at", "window_start_at"])),
      windowEndAt: toText(liveFirst(pickupRows, ["planned_window_end_at", "route_planned_end_at",
        "planned_end_at", "requested_window_end_at", "window_end_at"])),
      seal: toText(liveFirst(pickupRows, ["seal_number", "seal_id", "seal"])),
      expectedCount: toNumber(liveFirst(pickupRows, ["box_count", "package_count", "shipment_count", "expected_count", "expected_quantity"])),
      pickedCount: toNumber(liveFirst(pickupRows, ["picked_box_count", "picked_count", "confirmed_quantity"])),
      failureCount: pickupShipmentId && sources.pickupFailures?.complete
        ? failureRows.filter((row) => row.shipment_id === pickupShipmentId).length : null,
    },
    trip: {
      state: liveState(tripSources),
      id: toText(liveFirst(tripRows, ["route_run_id", "id"])),
      origin: toText(liveFirst(tripRows, ["origin", "origin_name", "origin_address"])),
      destination: toText(liveFirst(tripRows, ["destination", "destination_name", "destination_address"])),
      stage: toText(liveFirst(tripRows, ["status", "stage"])),
      plannedStartAt: toText(liveFirst(tripRows, ["planned_start_at"])),
      plannedEndAt,
      startedAt: toText(liveFirst(tripRows, ["started_at"])),
      endedAt: toText(liveFirst(tripRows, ["ended_at"])),
      eta: toText(liveFirst(tripRows, ["eta", "eta_at", "estimated_arrival_at"])),
      driverId: toText(liveFirst(tripRows, ["driver_user_id", "driver_id"])),
      vehicleId: toText(liveFirst(tripRows, ["vehicle_id"])),
      count: toNumber(liveFirst(tripRows, ["pickup_stop_count", "stop_count", "total_box_count"])),
      seal: toText(liveFirst(tripRows, ["seal_number", "seal_id", "seal"])),
      manifest: liveFirst(tripRows, ["shipments", "route_execution_manifest", "manifest"]),
      context: (() => {
        const value = liveFirst(tripRows, ["pickup_assignment", "route_assignment", "metadata"]);
        const record = asRecord(value);
        return Object.keys(record).length ? record : null;
      })(),
    },
    sortation: {
      state: liveState(sortationSources),
      // ponytail: no scoped sortation aggregate yet; use its canonical projection when available.
      bays: null,
      recent: null,
      inducted: null,
      throughput: null,
      minutes: null,
    },
  };
}
