-- Migration: tracking checksum charset fix
-- Purpose:
--   - Ensure iso7064_mod_37_36_checksum only emits uppercase alphanumeric
--     characters so tracking numbers remain within ^[A-Z0-9-]+$ as enforced
--     by pgTAP (028_tracking_policy.sql).

BEGIN;

CREATE OR REPLACE FUNCTION iso7064_mod_37_36_checksum(p_text text)
RETURNS text
LANGUAGE plpgsql
AS $function$
DECLARE
  -- 37 symbols mapped to 0..36, restricted to [0-9A-Z]
  -- The final slot reuses 'Z' for the 36th value instead of '*'.
  v_chars constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZZ';
  v_value int := 36; -- initial
  v_i int := 1;
  v_c text;
  v_p int;
BEGIN
  IF p_text IS NULL OR length(p_text) = 0 THEN
    RETURN '';
  END IF;

  WHILE v_i <= length(p_text) LOOP
    v_c := upper(substr(p_text, v_i, 1));
    v_p := position(v_c in v_chars) - 1; -- 0-based
    IF v_p < 0 THEN
      -- Skip unsupported characters (non-alphanumeric separators, etc.)
      v_i := v_i + 1;
      CONTINUE;
    END IF;
    v_value := ((v_value + v_p) * 2) % 37;
    v_i := v_i + 1;
  END LOOP;

  RETURN substr(v_chars, v_value + 1, 1);
END;
$function$;

COMMIT;

