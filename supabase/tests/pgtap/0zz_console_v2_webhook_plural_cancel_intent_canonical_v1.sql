BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SET search_path TO public, pgtap, extensions;

SELECT is(
  public.normalize_shipment_intent_v1('shipments.cancel', NULL),
  'shipment.delete',
  'plural mapping target shipments.cancel resolves to canonical shipment.delete intent'
);

SELECT is(
  public.normalize_shipment_intent_v1('shipments.delete', NULL),
  'shipment.delete',
  'plural mapping target shipments.delete resolves to canonical shipment.delete intent'
);

SELECT is(
  public.normalize_shipment_intent_v1('shipment.cancel', NULL),
  'shipment.delete',
  'singular shipment.cancel compatibility value resolves to canonical shipment.delete intent'
);

SELECT is(
  public.normalize_shipment_intent_v1('shipments_canceled', NULL),
  'shipment.delete',
  'underscore plural shipments_canceled compatibility value resolves to canonical shipment.delete intent'
);

SELECT is(
  public.normalize_shipment_intent_v1(NULL, 'shipments.cancel'),
  'shipment.delete',
  'plural event type shipments.cancel resolves to canonical shipment.delete intent'
);

SELECT is(
  public.normalize_shipment_intent_v1(NULL, 'shipment.cancel'),
  'shipment.delete',
  'singular event type shipment.cancel resolves to canonical shipment.delete intent'
);

SELECT is(
  public.resolve_webhook_shipment_intent_v1(
    jsonb_build_object(
      'event', jsonb_build_object('type', 'shipment.updated'),
      'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-PLURAL-CANCEL')
    ),
    'shipments.cancel',
    'shipment.updated'
  )->>'canonical_intent',
  'shipment.delete',
  'resolver canonicalizes plural mapping target shipments.cancel before workflow selection'
);

SELECT is(
  public.resolve_webhook_shipment_intent_v1(
    jsonb_build_object(
      'event', jsonb_build_object('type', 'shipment.updated'),
      'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-PLURAL-DELETE')
    ),
    'shipments.delete',
    'shipment.updated'
  )->>'canonical_intent',
  'shipment.delete',
  'resolver canonicalizes plural mapping target shipments.delete before workflow selection'
);

SELECT * FROM finish();

ROLLBACK;
