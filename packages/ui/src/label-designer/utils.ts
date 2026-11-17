import type { DraftRow, ScopeOption, ScopeType, ShipmentBoxOption, ShipmentOption } from "./types";

export function firstParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export function asText(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim();
}

export function shortId(value: string) {
  return value.slice(0, 8);
}

export function formatJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return safeObject(parsed);
  } catch {
    return {};
  }
}

export function safeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function parseDraftRows(value: unknown): DraftRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      const record = safeObject(row);
      const id = asText(record.id);
      const scopeType = asText(record.scope_type) as ScopeType;
      const scopeId = asText(record.scope_id);
      if (!id || !scopeType || !scopeId) return null;
      return {
        id,
        scope_type: scopeType,
        scope_id: scopeId,
        label_type: asText(record.label_type) || "shipping",
        draft_name: asText(record.draft_name) || null,
        draft_value: safeObject(record.draft_value),
        status: asText(record.status) || "draft",
        updated_at: asText(record.updated_at) || null,
        published_at: asText(record.published_at) || null,
      };
    })
    .filter((row): row is DraftRow => Boolean(row));
}

export function parseShipmentOptions(value: unknown): ShipmentOption[] {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => {
      const record = safeObject(item);
      const id = asText(record.id);
      if (!id) return null;
      const tracking = asText(record.tracking_number);
      const status = asText(record.status);
      const labelParts = [tracking || shortId(id), status].filter(Boolean);
      return {
        id,
        label: labelParts.join(" \u2022 "),
      };
    })
    .filter((item): item is ShipmentOption => Boolean(item));
}

export function parseShipmentBoxOptions(value: unknown): ShipmentBoxOption[] {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => {
      const record = safeObject(item);
      const id = asText(record.id);
      if (!id) return null;
      const boxNumber = Number(record.box_number);
      const barcode = asText(record.barcode);
      const label = Number.isFinite(boxNumber)
        ? `Box ${boxNumber}${barcode ? ` \u2022 ${barcode}` : ""}`
        : barcode || shortId(id);
      return { id, label };
    })
    .filter((item): item is ShipmentBoxOption => Boolean(item));
}

export function parseScopeOptions(params: {
  organizationId: string;
  clients: unknown;
  senders: unknown;
}): ScopeOption[] {
  const options: ScopeOption[] = [
    {
      key: `tenant:${params.organizationId}`,
      scopeType: "tenant",
      scopeId: params.organizationId,
      label: `Tenant \u2022 ${shortId(params.organizationId)}`,
    },
  ];

  const clients = Array.isArray(params.clients) ? params.clients : [];
  for (const row of clients) {
    const record = safeObject(row);
    const id = asText(record.id);
    if (!id) continue;
    const name = asText(record.name) || asText(record.slug) || shortId(id);
    options.push({
      key: `client:${id}`,
      scopeType: "client",
      scopeId: id,
      label: `Client \u2022 ${name}`,
    });
  }

  const senders = Array.isArray(params.senders) ? params.senders : [];
  for (const row of senders) {
    const record = safeObject(row);
    const id = asText(record.id);
    if (!id) continue;
    const name = asText(record.name) || asText(record.brand_name) || shortId(id);
    options.push({
      key: `sender:${id}`,
      scopeType: "sender",
      scopeId: id,
      label: `Sender \u2022 ${name}`,
    });
  }

  return options;
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error || new Error("Could not read file."));
    };
    reader.onload = () => {
      const raw = typeof reader.result === "string" ? reader.result : "";
      const marker = raw.indexOf(",");
      resolve(marker >= 0 ? raw.slice(marker + 1) : raw);
    };
    reader.readAsDataURL(file);
  });
}

export function isDraftStatus(status: string) {
  return status.trim().toLowerCase() === "draft";
}

export function parseScopeKey(raw: string | null) {
  if (!raw) return null;
  const [scopeType, scopeId] = raw.split(":");
  if (!scopeType || !scopeId) return null;
  const normalizedScopeType = scopeType.trim().toLowerCase();
  if (
    normalizedScopeType !== "tenant" &&
    normalizedScopeType !== "client" &&
    normalizedScopeType !== "sender"
  ) {
    return null;
  }
  const normalizedScopeId = scopeId.trim();
  if (!normalizedScopeId) return null;
  return `${normalizedScopeType}:${normalizedScopeId}`;
}
