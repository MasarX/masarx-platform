-- Migration: Tracking generator helpers and functions
-- Purpose: Provide policy-driven tracking number generation with fast sequence path

BEGIN;

-- 1) Global sequence for tracking numbers (high CACHE for low contention)
CREATE SEQUENCE IF NOT EXISTS tracking_global_seq CACHE 1000;

-- 2) Helper: encode bigint to BASE36 uppercase
CREATE OR REPLACE FUNCTION encode_base36(p_value bigint)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_chars constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  v_n bigint := p_value;
  v_out text := '';
  v_digit int;
BEGIN
  IF v_n IS NULL OR v_n < 0 THEN
    RAISE EXCEPTION 'encode_base36: invalid input %', v_n;
  END IF;
  IF v_n = 0 THEN
    RETURN '0';
  END IF;
  WHILE v_n > 0 LOOP
    v_digit := (v_n % 36)::int;
    v_out := substr(v_chars, v_digit + 1, 1) || v_out;
    v_n := v_n / 36;
  END LOOP;
  RETURN v_out;
END;
$$;

-- 3) Helper: encode bigint to Crockford Base32 uppercase (I/O skipped)
CREATE OR REPLACE FUNCTION encode_crockford32(p_value bigint)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_chars constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; -- no I, O
  v_n bigint := p_value;
  v_out text := '';
  v_digit int;
  v_base int := 32;
BEGIN
  IF v_n IS NULL OR v_n < 0 THEN
    RAISE EXCEPTION 'encode_crockford32: invalid input %', v_n;
  END IF;
  IF v_n = 0 THEN
    RETURN '0';
  END IF;
  WHILE v_n > 0 LOOP
    v_digit := (v_n % v_base)::int;
    v_out := substr(v_chars, v_digit + 1, 1) || v_out;
    v_n := v_n / v_base;
  END LOOP;
  RETURN v_out;
END;
$$;

-- 4) Helper: ISO 7064 mod 37,36 checksum (simplified, returns 1-char check)
CREATE OR REPLACE FUNCTION iso7064_mod_37_36_checksum(p_text text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_chars constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ*'; -- 37 symbols
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
      -- skip unsupported chars
      v_i := v_i + 1;
      CONTINUE;
    END IF;
    v_value := ((v_value + v_p) * 2) % 37;
    v_i := v_i + 1;
  END LOOP;
  RETURN substr(v_chars, v_value + 1, 1);
END;
$$;

-- 5) Main generator using tokenized policy
--   p_scope_type: 'tenant'|'client'|'sender' (for future use)
--   p_scope_id: scope identifier UUID (unused for global sequence)
--   p_policy: settings JSON (tracking_policy)
CREATE OR REPLACE FUNCTION generate_tracking_number(
  p_scope_type text,
  p_scope_id uuid,
  p_policy jsonb
)
RETURNS text
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $$
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
  v_n int := jsonb_array_length(v_tokens);
  v_now timestamptz := clock_timestamp();
  v_datefrag text;
  v_seq_frag text;
  v_chk text := '';
BEGIN
  -- prepare prefix
  IF v_prefix IS NULL THEN v_prefix := ''; END IF;
  IF v_max_prefix IS NOT NULL AND length(v_prefix) > v_max_prefix THEN
    v_prefix := substr(v_prefix, 1, v_max_prefix);
  END IF;

  -- scan tokens
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

  RETURN upper(v_buf);
END;
$$;

COMMIT;

