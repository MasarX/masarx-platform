-- Restore optional scoped operator handoff configuration through current settings history.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT pg_advisory_xact_lock(hashtext('20261025005000_tracking_operator_handoff_registry_v1'));

UPDATE public.schema_registry
SET schema = jsonb_set(schema, '{properties,operator_handoff}', $handoff_schema$
{
  "type": "object",
  "properties": {
    "enabled": {
      "type": "boolean"
    },
    "label": {
      "type": "string"
    },
    "label_ar": {
      "type": "string"
    },
    "description": {
      "type": "string"
    },
    "description_ar": {
      "type": "string"
    },
    "identifier_param": {
      "type": "string"
    },
    "identifier_source": {
      "type": "string"
    },
    "tab_param": {
      "type": "string"
    },
    "tab": {
      "type": "string"
    },
    "route_targets": {
      "type": "object",
      "properties": {
        "console": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string"
            }
          }
        }
      }
    }
  }
}
$handoff_schema$::jsonb, TRUE), updated_at = now()
WHERE category = 'ui_tracking_registry' AND version = 1 AND is_active
  AND schema #> '{properties,operator_handoff}' IS NULL;

DO $handoff_defaults$
DECLARE
  v_current RECORD;
BEGIN
  FOR v_current IN
    SELECT s.settings_version_id, sv.schema_version, sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_tracking_registry'
      AND s.scope_type = 'global' AND s.scope_id IS NULL
    FOR UPDATE OF s
  LOOP
    IF v_current.value ? 'operator_handoff' THEN CONTINUE; END IF;
    PERFORM public.upsert_settings_value_v1(
      'ui_tracking_registry', 'global', NULL,
      jsonb_set(v_current.value, '{operator_handoff}', $handoff_value$
{
  "enabled": true,
  "label": "Open in Console",
  "label_ar": "فتح في لوحة العمليات",
  "description": "Open this shipment in the Console operator context.",
  "description_ar": "افتح هذه الشحنة في سياق المشغّل في لوحة العمليات.",
  "identifier_param": "focus",
  "identifier_source": "tracking_number",
  "tab_param": "tab",
  "tab": "timeline",
  "route_targets": {
    "console": {
      "path": "/operate/shipments"
    }
  }
}
$handoff_value$::jsonb, TRUE), v_current.schema_version,
      'Restore scoped tracking-to-Console operator handoff'
    );
  END LOOP;
END;
$handoff_defaults$;
COMMIT;
