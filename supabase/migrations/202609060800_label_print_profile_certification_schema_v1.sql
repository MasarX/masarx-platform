-- Preserve all certification aliases consumed by onboarding label readiness.
-- Schema-only append: no evidence seed, settings value, or pointer rewrite.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
DO $certification$
DECLARE
  v_current public.schema_registry%ROWTYPE;
  v_version INTEGER;
  v_canonical JSONB := '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"label_print_profile.schema.json","title":"label_print_profile","type":"object","required":["version","profile_key","dpi"],"additionalProperties":false,"properties":{"version":{"type":"integer","minimum":1},"profile_key":{"type":"string","minLength":1,"maxLength":64},"dpi":{"type":"integer","minimum":72,"maximum":600},"media":{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","enum":["thermal","laser","inkjet","unknown"]},"darkness":{"type":"integer","minimum":0,"maximum":30},"width_inch":{"type":"number","minimum":1,"maximum":10},"height_inch":{"type":"number","minimum":1,"maximum":15}}},"barcode":{"type":"object","additionalProperties":false,"properties":{"quiet_zone_modules":{"type":"integer","minimum":0,"maximum":40},"min_quiet_zone_modules":{"type":"integer","minimum":0,"maximum":40},"target_module_width_dots":{"type":"integer","minimum":1,"maximum":10},"hard_min_module_width_dots":{"type":"integer","minimum":1,"maximum":10}}}}}'::jsonb;
  v_extended JSONB := '{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"label_print_profile.schema.json","title":"label_print_profile","type":"object","required":["version","profile_key","dpi"],"additionalProperties":false,"properties":{"version":{"type":"integer","minimum":1},"profile_key":{"type":"string","minLength":1,"maxLength":64},"dpi":{"type":"integer","minimum":72,"maximum":600},"media":{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","enum":["thermal","laser","inkjet","unknown"]},"darkness":{"type":"integer","minimum":0,"maximum":30},"width_inch":{"type":"number","minimum":1,"maximum":10},"height_inch":{"type":"number","minimum":1,"maximum":15},"certification":{"anyOf":[{"type":"null"},{"type":"object","minProperties":1},{"type":"array","minItems":1}]}}},"barcode":{"type":"object","additionalProperties":false,"properties":{"quiet_zone_modules":{"type":"integer","minimum":0,"maximum":40},"min_quiet_zone_modules":{"type":"integer","minimum":0,"maximum":40},"target_module_width_dots":{"type":"integer","minimum":1,"maximum":10},"hard_min_module_width_dots":{"type":"integer","minimum":1,"maximum":10}}},"printer_certification":{"anyOf":[{"type":"null"},{"type":"object","minProperties":1},{"type":"array","minItems":1}]},"certification":{"anyOf":[{"type":"null"},{"type":"object","minProperties":1},{"type":"array","minItems":1}]},"certified_printers":{"anyOf":[{"type":"null"},{"type":"object","minProperties":1},{"type":"array","minItems":1}]}}}'::jsonb;
BEGIN
  LOCK TABLE public.schema_registry IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_current FROM public.schema_registry
   WHERE category = 'label_print_profile' AND is_active
   ORDER BY version DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active label print profile schema is missing';
  END IF;
  IF v_current.schema = v_extended THEN
    RETURN;
  END IF;
  -- Do not replace custom constraints or guess how custom references compose.
  IF v_current.schema IS DISTINCT FROM v_canonical THEN
    RAISE EXCEPTION 'custom label print profile schema requires explicit certification review';
  END IF;
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
    FROM public.schema_registry WHERE category = 'label_print_profile';
  INSERT INTO public.schema_registry(category, version, schema, description, examples, is_active)
  VALUES ('label_print_profile', v_version, v_extended,
    'Printer profile with optional onboarding certification evidence aliases',
    v_current.examples, TRUE);
  UPDATE public.schema_registry SET is_active = FALSE
   WHERE category = 'label_print_profile' AND version <> v_version AND is_active;
END;
$certification$;
COMMIT;
