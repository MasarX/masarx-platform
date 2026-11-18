import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import { loadPickupRequestRows } from "./pickup-page-shared";
import { normalizeObject, stringValue } from "./pickup-operations-utils";
import { formatReferenceValue } from "./resource-utils";
import { formatUiError } from "./utils";

export type PickupLookupOption = { value: string; label: string; groupValue?: string };
type Context = {
  org?: { id?: string | null } | null;
  access_scope?: { scope_type?: string | null; scope_id?: string | null; scope_label?: string | null } | null;
};
type LookupKey = "clients" | "senders" | "branches" | "drivers" | "vehicles" | "shipments";
const text = (value: unknown) => stringValue(value)?.trim() || "";

export function pickupLookupLabel(row: Record<string, unknown>, kind: LookupKey) {
  const labelKeys: Record<LookupKey, string[]> = {
    clients: ["name", "slug"], senders: ["name", "brand_name"], branches: ["name", "code"],
    drivers: ["full_name", "email"], vehicles: ["label", "plate_number", "vin"],
    shipments: ["tracking_number", "client_reference_number", "carrier_reference_number"],
  };
  const names = { clients: "Client", senders: "Sender", branches: "Branch", drivers: "Driver", vehicles: "Vehicle", shipments: "Shipment" };
  return labelKeys[kind].map((key) => text(row[key])).find(Boolean)
    || `${names[kind]} ${formatReferenceValue(text(row.id || row.shipment_id || row.vehicle_id))}`;
}

export async function loadPickupLookups(me: Context | null, mode: "request" | "wave") {
  const options: Record<LookupKey, PickupLookupOption[]> = {
    clients: [], senders: [], branches: [], drivers: [], vehicles: [], shipments: [],
  };
  const errors: string[] = [];
  if (!me) return { options, error: "Your session could not be loaded." };
  const ui = createUiServerClient();
  const organizationId = text(me.org?.id);
  const scopeType = text(me.access_scope?.scope_type).toLowerCase();
  const scopeId = text(me.access_scope?.scope_id);
  let clientId = scopeType === "client" ? scopeId : "";
  const senderId = scopeType === "sender" ? scopeId : "";
  if (senderId) {
    try {
      clientId = text(normalizeObject(await ui.getResource("senders", senderId))?.client_id);
      if (!clientId) throw new Error("Sender client scope could not be resolved.");
    } catch (error) {
      return { options, error: formatUiError(error, "Sender scope unavailable.") };
    }
  }
  const keys: LookupKey[] = mode === "request"
    ? ["clients", "senders", "branches"] : ["branches", "drivers", "vehicles", "shipments"];
  await Promise.all(keys.map(async (kind) => {
    try {
      let rows: Record<string, unknown>[];
      if (kind === "vehicles") {
        rows = await ui.rpc<Record<string, unknown>[]>("pickup_vehicle_lookup_v1", {
          p_organization_id: organizationId || null, p_limit: 250,
        });
      } else if (kind === "shipments") {
        const result = await loadPickupRequestRows({ clientId, senderId, status: "pickup_requested", limit: 250 });
        if (result.error) throw new Error(result.error);
        rows = result.rows;
      } else {
        const filters: Record<string, unknown> = organizationId ? { organization_id: organizationId } : {};
        if (kind === "clients" && clientId) filters.id = clientId;
        if (kind === "senders" && clientId) filters.client_id = clientId;
        if (kind === "senders" && senderId) filters.id = senderId;
        if (kind === "drivers") Object.assign(filters, { user_type: "driver", status: "active" });
        rows = [];
        // shortcut: static choices stop at 1000; add server-side search when tenants exceed this list size.
        while (rows.length < 1000) {
          const result = await ui.listResource(kind === "drivers" ? "users" : kind, filters, 100, rows.length);
          const page = Array.isArray(result.items) ? result.items : [];
          rows.push(...page);
          if (!page.length || page.length < Math.min(Number(result.limit) || 100, 100)) break;
        }
      }
      options[kind] = Array.from(new Map((Array.isArray(rows) ? rows : []).flatMap((row) => {
        const value = text(kind === "shipments" ? row.shipment_id : kind === "vehicles" ? row.vehicle_id : row.id);
        return value ? [[value, { value, label: pickupLookupLabel(row, kind),
          ...(kind === "senders" ? { groupValue: text(row.client_id) } : {}) }] as const] : [];
      })).values());
    } catch (error) {
      // Own scope remains selectable below without permission to enumerate its parent resource.
      if (!((kind === "clients" && clientId) || (kind === "senders" && senderId))) {
        errors.push(formatUiError(error, `Unable to load ${kind} choices.`));
      }
    }
  }));
  if (mode === "request" && clientId && !options.clients.some((option) => option.value === clientId)) {
    options.clients.push({ value: clientId, label: scopeType === "client" && text(me.access_scope?.scope_label)
      || `Client ${formatReferenceValue(clientId)}` });
  }
  if (mode === "request" && senderId && !options.senders.some((option) => option.value === senderId)) {
    options.senders.push({ value: senderId, groupValue: clientId,
      label: text(me.access_scope?.scope_label) || `Sender ${formatReferenceValue(senderId)}` });
  }
  return { options, error: errors.join(" ") || null };
}
