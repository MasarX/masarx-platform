-- Migration: generate_tracking_number fallback tokens
-- Purpose: Ensure tracking numbers are generated even when scoped policy has no token array.

BEGIN;

CREATE OR REPLACE FUNCTION generate_tracking_number(
  p_scope_type text,
  p_scope_id uuid,
  p_policy jsonb
)
RETURNS text
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_alphabet text := COALESCE(p_policy->>'alphabet', 'BASE36');
  v_checksum text := COALESCE(p_policy->>'checksum', 'iso7064_mod_37_36');
  v_prefix text := COALESCE(p_policy->'prefix'->>'value', '');
  v_sep text := COALESCE(p_policy->'prefix'->>'separator', '');
  v_max_prefix int := COALESCE((p_policy->'prefix'->>'max_len')::int, 4);
  v_tokens jsonb := COALESCE(p_policy->'tokens', '[]'::jsonb);
  v_seq bigint;
  v_seq_token_len int := 6;
  v_date_pattern text := 'YY';
  v_buf text := '';
  v_part text;
  v_i int := 0;
  v_n int;
  v_now timestamptz := clock_timestamp();
  v_datefrag text;
  v_seq_frag text;
  v_chk text := '';
BEGIN
  IF v_prefix IS NULL THEN
    v_prefix := '';
  END IF;

  IF v_max_prefix IS NOT NULL AND length(v_prefix) > v_max_prefix THEN
    v_prefix := substr(v_prefix, 1, v_max_prefix);
  END IF;

  IF v_tokens IS NULL OR jsonb_typeof(v_tokens) <> 'array' OR jsonb_array_length(v_tokens) = 0 THEN
    v_tokens := jsonb_build_array(
      jsonb_build_object('type', 'seq', 'len', 6)
    );
  END IF;

  v_n := jsonb_array_length(v_tokens);

  WHILE v_i < v_n LOOP
    v_part := upper(COALESCE((v_tokens->v_i->>'type'), ''));
    IF v_part = 'PREFIX' THEN
      v_buf := v_buf || upper(v_prefix);
      IF v_sep IS NOT NULL AND v_sep <> '' THEN
        v_buf := v_buf || v_sep;
      END IF;
    ELSIF v_part = 'DATE' THEN
      v_date_pattern := COALESCE(v_tokens->v_i->>'pattern', 'YY');
      v_datefrag := to_char((v_now at time zone 'UTC'), v_date_pattern);
      v_buf := v_buf || v_datefrag;
    ELSIF v_part = 'SEQ' THEN
      v_seq_token_len := COALESCE((v_tokens->v_i->>'len')::int, 6);
      v_seq := nextval('tracking_global_seq');
      IF v_alphabet = 'CROCKFORD32' THEN
        v_seq_frag := encode_crockford32(v_seq);
      ELSE
        v_seq_frag := encode_base36(v_seq);
      END IF;
      IF v_seq_token_len > 0 THEN
        v_seq_frag := lpad(v_seq_frag, v_seq_token_len, '0');
      END IF;
      v_buf := v_buf || v_seq_frag;
    ELSIF v_part = 'CHK' THEN
      IF v_checksum = 'iso7064_mod_37_36' THEN
        v_chk := iso7064_mod_37_36_checksum(v_buf);
      ELSE
        v_chk := '';
      END IF;
      v_buf := v_buf || v_chk;
    END IF;
    v_i := v_i + 1;
  END LOOP;

  RETURN v_buf;
END;
$function$;

COMMENT ON FUNCTION generate_tracking_number(text, uuid, jsonb)
  IS 'Generate tracking number using tokenized policy (fallback to sequence-only tokens when unset).';

COMMIT;
