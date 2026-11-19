const SHIPMENT_CREATE_INTENTS = new Set([
  'shipment.create',
  'shipments.create',
  'shipment.created',
]);

export function normalizeWebhookIntent(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function isShipmentCreateIntent(value: unknown): boolean {
  return SHIPMENT_CREATE_INTENTS.has(normalizeWebhookIntent(value));
}
