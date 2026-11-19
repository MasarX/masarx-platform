interface ApiGatewayRoutePayloadTemplateInput {
  path_pattern?: string | null;
  path_template?: string | null;
  policy?: Record<string, unknown> | null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstMappingPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const first = value.split('|')[0]?.trim();
  return first || null;
}

function setPayloadPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return;
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

function localDateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function compactReference(seed: string): string {
  return seed.replace(/[^a-z0-9]/gi, '').slice(-12).toUpperCase() || String(Date.now()).slice(-8);
}

function sampleValueForMapping(mappingKey: string, referenceSeed: string): unknown {
  const key = mappingKey.toLowerCase();
  const reference = compactReference(referenceSeed);
  if (key.includes('box_count')) return 1;
  if (key.includes('cod_amount')) return 25.5;
  if (key.includes('lat')) return key.includes('origin') ? 24.7136 : 24.7743;
  if (key.includes('lng')) return key.includes('origin') ? 46.6753 : 46.7386;
  if (key.includes('recipient_name')) return 'API Gateway Recipient';
  if (key.includes('recipient_phone')) return '+12025550123';
  if (key.includes('shipment_id') || key.includes('shipment_identifier')) return `SHIP-${reference}`;
  if (key.includes('tracking_number')) return `TRK-${reference}`;
  if (key.includes('status')) return 'cancelled';
  if (key.includes('cancel_reason') || key.includes('delete_reason') || key.includes('reason')) {
    return 'Console API Gateway mutation proof';
  }
  if (key.includes('reschedule_date')) return localDateOffset(2);
  if (key.includes('client_reference')) return `API-${reference}`;
  if (key.includes('provider_reference_id')) return `REF-${reference}`;
  if (key.includes('provider_shipment_id')) return `SHIP-${reference}`;
  if (key.includes('promised_delivery_date')) return localDateOffset(1);
  if (key.includes('service_type')) return 'delivery';
  if (key.includes('service_level')) return 'express';
  if (key.includes('special_instructions')) return 'Console API Gateway test';
  if (key.includes('short_code')) return 'RRRA1234';
  if (key.includes('postal')) return '12212';
  if (key.includes('country')) return 'SA';
  if (key.includes('province') || key.includes('region')) return 'Riyadh';
  if (key.includes('district')) return key.includes('origin') ? 'Al Malaz' : 'Al Olaya';
  if (key.includes('city')) return 'Riyadh';
  if (key.includes('line2')) return key.includes('origin') ? 'Dock 2' : 'Unit 12';
  if (key.includes('line1') || key.includes('raw')) {
    return key.includes('origin') ? 'API Gateway Origin Warehouse' : 'API Gateway Destination Tower';
  }
  return `value-${reference}`;
}

export function buildApiGatewayRoutePayloadTemplate(
  route: ApiGatewayRoutePayloadTemplateInput | null | undefined,
  referenceSeed: string,
): Record<string, unknown> {
  const policy = objectRecord(route?.policy);
  const postprocess = objectRecord(policy.postprocess);
  const extract = objectRecord(postprocess.extract);
  const payload: Record<string, unknown> = {};

  for (const [mappingKey, mappingPath] of Object.entries(extract)) {
    const path = firstMappingPath(mappingPath);
    if (!path) continue;
    setPayloadPath(payload, path, sampleValueForMapping(mappingKey, referenceSeed));
  }

  return payload;
}

export function formatApiGatewayRoutePayloadTemplate(
  route: ApiGatewayRoutePayloadTemplateInput | null | undefined,
  referenceSeed: string,
): string {
  const payload = buildApiGatewayRoutePayloadTemplate(route, referenceSeed);
  return JSON.stringify(payload, null, 2);
}
