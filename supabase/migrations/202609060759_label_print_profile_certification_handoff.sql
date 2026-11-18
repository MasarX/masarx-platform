-- Restore the shipped v1 before the canonical certification schema is appended.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $handoff$
DECLARE
  v_active public.schema_registry%ROWTYPE;
  v_canonical JSONB := '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"label_print_profile.schema.json","title":"label_print_profile","type":"object","required":["version","profile_key","dpi"],"additionalProperties":false,"properties":{"version":{"type":"integer","minimum":1},"profile_key":{"type":"string","minLength":1,"maxLength":64},"dpi":{"type":"integer","minimum":72,"maximum":600},"media":{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","enum":["thermal","laser","inkjet","unknown"]},"darkness":{"type":"integer","minimum":0,"maximum":30},"width_inch":{"type":"number","minimum":1,"maximum":10},"height_inch":{"type":"number","minimum":1,"maximum":15}}},"barcode":{"type":"object","additionalProperties":false,"properties":{"quiet_zone_modules":{"type":"integer","minimum":0,"maximum":40},"min_quiet_zone_modules":{"type":"integer","minimum":0,"maximum":40},"target_module_width_dots":{"type":"integer","minimum":1,"maximum":10},"hard_min_module_width_dots":{"type":"integer","minimum":1,"maximum":10}}}}}'::jsonb;
  v_extended JSONB := '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"label_print_profile.schema.json","title":"label_print_profile","type":"object","required":["version","profile_key","dpi"],"additionalProperties":false,"properties":{"version":{"type":"integer","minimum":1},"profile_key":{"type":"string","minLength":1,"maxLength":64},"dpi":{"type":"integer","minimum":72,"maximum":600},"media":{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","enum":["thermal","laser","inkjet","unknown"]},"darkness":{"type":"integer","minimum":0,"maximum":30},"width_inch":{"type":"number","minimum":1,"maximum":10},"height_inch":{"type":"number","minimum":1,"maximum":15},"certification":{"anyOf":[{"type":"null"},{"type":"object","minProperties":1},{"type":"array","minItems":1}]}}},"barcode":{"type":"object","additionalProperties":false,"properties":{"quiet_zone_modules":{"type":"integer","minimum":0,"maximum":40},"min_quiet_zone_modules":{"type":"integer","minimum":0,"maximum":40},"target_module_width_dots":{"type":"integer","minimum":1,"maximum":10},"hard_min_module_width_dots":{"type":"integer","minimum":1,"maximum":10}}},"printer_certification":{"anyOf":[{"type":"null"},{"type":"object","minProperties":1},{"type":"array","minItems":1}]},"certification":{"anyOf":[{"type":"null"},{"type":"object","minProperties":1},{"type":"array","minItems":1}]},"certified_printers":{"anyOf":[{"type":"null"},{"type":"object","minProperties":1},{"type":"array","minItems":1}]}}}'::jsonb;
  v_july_evidence JSONB := $evidence${
    "type": "object",
    "required": [
      "certification_id",
      "certified_at",
      "evidence_reference",
      "printer_model",
      "printer_dpi",
      "media",
      "result"
    ],
    "additionalProperties": false,
    "properties": {
      "certification_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "certified_at": {
        "type": "string",
        "minLength": 10,
        "maxLength": 64
      },
      "evidence_reference": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "printer_model": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "printer_serial": {
        "type": "string",
        "maxLength": 128
      },
      "profile_key": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "printer_dpi": {
        "type": "integer",
        "minimum": 72,
        "maximum": 600
      },
      "media": {
        "type": "object",
        "additionalProperties": true
      },
      "test_artifact_ref": {
        "type": "string",
        "maxLength": 512
      },
      "result": {
        "type": "string",
        "enum": [
          "passed",
          "failed",
          "conditional"
        ]
      },
      "recorded_by_user_id": {
        "type": "string",
        "maxLength": 128
      },
      "source": {
        "type": "string",
        "maxLength": 128
      }
    }
  }$evidence$::jsonb;
BEGIN
  LOCK TABLE public.schema_registry IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO STRICT v_active
    FROM public.schema_registry
   WHERE category = 'label_print_profile' AND is_active;

  IF v_active.schema IN (v_canonical, v_extended) THEN
    RETURN;
  END IF;
  IF v_active.version <> 2 OR v_active.schema IS DISTINCT FROM
       jsonb_set(v_canonical, '{properties,printer_certification}', v_july_evidence) THEN
    RAISE EXCEPTION 'Unrecognized active label print profile schema requires explicit certification review';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_registry
     WHERE category = 'label_print_profile' AND version = 1 AND schema = v_canonical
  ) THEN
    RAISE EXCEPTION 'Canonical label print profile v1 is missing or changed';
  END IF;

  UPDATE public.schema_registry
     SET is_active = (version = 1)
   WHERE category = 'label_print_profile' AND version IN (1, 2);
END;
$handoff$;
COMMIT;
