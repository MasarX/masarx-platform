-- Normalize the existing plural create alias before sender/client admission.
BEGIN;
SET LOCAL lock_timeout = '30s';
CREATE OR REPLACE FUNCTION public.normalize_shipment_intent_v1(
  p_intent TEXT,
  p_event_type TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_intent TEXT := lower(NULLIF(btrim(COALESCE(p_intent, '')), ''));
  v_event_type TEXT := lower(NULLIF(btrim(COALESCE(p_event_type, '')), ''));
BEGIN
  IF v_intent IN (
    'shipment.create',
    'shipment.updated',
    'shipment.swap',
    'shipment.return',
    'shipment.modify',
    'shipment.delete',
    'shipment.cancel',
    'shipment.canceled',
    'shipment.cancelled',
    'shipment.reschedule',
    'shipments.cancel',
    'shipments.canceled',
    'shipments.cancelled',
    'shipments.delete',
    'shipments.reschedule',
    'update.status',
    'update.geocode',
    'update.address',
    'update.driver',
    'update.action',
    'update.attachment'
  ) THEN
    RETURN CASE
      WHEN v_intent IN (
        'shipment.cancel',
        'shipment.canceled',
        'shipment.cancelled',
        'shipments.cancel',
        'shipments.canceled',
        'shipments.cancelled',
        'shipments.delete'
      ) THEN 'shipment.delete'
      WHEN v_intent = 'shipments.reschedule' THEN 'shipment.reschedule'
      ELSE v_intent
    END;
  END IF;

  CASE COALESCE(v_intent, v_event_type)
    WHEN 'shipment_create' THEN RETURN 'shipment.create';
    WHEN 'shipments.create' THEN RETURN 'shipment.create';
    WHEN 'shipment_update' THEN RETURN 'shipment.updated';
    WHEN 'shipment_swap' THEN RETURN 'shipment.swap';
    WHEN 'shipment_return' THEN RETURN 'shipment.return';
    WHEN 'shipment_modify' THEN RETURN 'shipment.modify';
    WHEN 'shipment_delete' THEN RETURN 'shipment.delete';
    WHEN 'shipment_cancel' THEN RETURN 'shipment.delete';
    WHEN 'shipment_cancelled' THEN RETURN 'shipment.delete';
    WHEN 'shipment_canceled' THEN RETURN 'shipment.delete';
    WHEN 'shipments_delete' THEN RETURN 'shipment.delete';
    WHEN 'shipments_cancel' THEN RETURN 'shipment.delete';
    WHEN 'shipments_cancelled' THEN RETURN 'shipment.delete';
    WHEN 'shipments_canceled' THEN RETURN 'shipment.delete';
    WHEN 'shipment_reschedule' THEN RETURN 'shipment.reschedule';
    WHEN 'shipment_rescheduled' THEN RETURN 'shipment.reschedule';
    WHEN 'shipments_reschedule' THEN RETURN 'shipment.reschedule';
    WHEN 'status_update' THEN RETURN 'update.status';
    WHEN 'shipment_status_update' THEN RETURN 'update.status';
    WHEN 'shipment_update_status' THEN RETURN 'update.status';
    WHEN 'shipment_update_geocode' THEN RETURN 'update.geocode';
    WHEN 'shipment_update_address' THEN RETURN 'update.address';
    WHEN 'shipment_update_driver' THEN RETURN 'update.driver';
    WHEN 'shipment_update_action' THEN RETURN 'update.action';
    WHEN 'shipment_update_attachment' THEN RETURN 'update.attachment';
    WHEN 'shipment.created' THEN RETURN 'shipment.create';
    WHEN 'shipment.updated' THEN RETURN 'shipment.updated';
    WHEN 'shipment.cancel' THEN RETURN 'shipment.delete';
    WHEN 'shipment.canceled' THEN RETURN 'shipment.delete';
    WHEN 'shipment.cancelled' THEN RETURN 'shipment.delete';
    WHEN 'shipment.rescheduled' THEN RETURN 'shipment.reschedule';
    WHEN 'shipments.cancel' THEN RETURN 'shipment.delete';
    WHEN 'shipments.delete' THEN RETURN 'shipment.delete';
    WHEN 'shipments.canceled' THEN RETURN 'shipment.delete';
    WHEN 'shipments.cancelled' THEN RETURN 'shipment.delete';
    WHEN 'shipments.rescheduled' THEN RETURN 'shipment.reschedule';
    WHEN 'shipments.reschedule' THEN RETURN 'shipment.reschedule';
    ELSE
      RETURN COALESCE(v_intent, v_event_type);
  END CASE;
END;
$function$;
COMMIT;
