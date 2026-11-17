import type {
  MobileAddressPolicy,
  MobileCommunicationPolicy,
  MobilePlatform,
} from "./mobile-shell-policy";

type JsonRecord = Record<string, unknown>;

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
  const shortAddress = pickAnyText(record, ["short_address", "shortAddress", "address_short"]);

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
      pickAnyText(record, ["short_address", "shortAddress", "address_short"]),
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
  const records = candidateRecords(detail);
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
  ]);
  const explicitVariance = pickAnyNumberFromRecords(records, [
    "variance",
    "variance_amount",
    "difference",
  ]);

  const variance =
    explicitVariance != null
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
  };
}

export function extractOperationalStopSnapshot(detailValue: unknown): OperationalStopSnapshot {
  const detail = asRecord(detailValue);
  const records = candidateRecords(detail);
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
  const codAmount = pickAnyNumberFromRecords(records, [
    "cod_amount",
    "expected_amount",
    "cash_on_delivery_amount",
    "amount_due",
    "amount_to_collect",
    "collection_amount",
  ]);
  const expectedAmount = pickAnyNumberFromRecords(records, [
    "expected_amount",
    "cod_amount",
    "cash_on_delivery_amount",
    "amount_due",
    "amount_to_collect",
    "collection_amount",
  ]);
  const currency = pickAnyTextFromRecords(records, [
    "currency",
    "currency_code",
    "cod_currency",
  ]);
  const collectionRequired =
    pickAnyBooleanFromRecords(records, ["collection_required"]) ??
    (expectedAmount != null ? expectedAmount > 0 : codAmount != null ? codAmount > 0 : null);
  const paymentModeLabel = pickAnyTextFromRecords(records, ["payment_mode_label"]);
  const allowedMethods = pickAnyTextArrayFromRecords(records, ["allowed_methods"]);

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
    codBadge:
      stop.codAmount != null
        ? `${stop.currency ?? "SAR"} ${Math.round(stop.codAmount)} COD`
        : null,
  };
}

export function extractTaskCardSnapshot(detailValue: unknown): TaskCardSnapshot {
  const stop = extractOperationalStopSnapshot(detailValue);

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
    codBadge:
      stop.codAmount != null
        ? `${stop.currency ?? "SAR"} ${Math.round(stop.codAmount)} COD`
        : null,
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
