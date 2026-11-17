-- Fixup: restore tracking helper functions required by generate_tracking_number
BEGIN;

-- BASE36 encoder
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

-- Crockford Base32 encoder (no I/O letters)
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

-- ISO 7064 mod 37,36 checksum (returns single-char check symbol)
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
      v_i := v_i + 1; -- skip unsupported
      CONTINUE;
    END IF;
    v_value := ((v_value + v_p) * 2) % 37;
    v_i := v_i + 1;
  END LOOP;
  RETURN substr(v_chars, v_value + 1, 1);
END;
$$;

COMMIT;