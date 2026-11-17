-- Plan: PLAN-202512-api-gateway-logestechs-v2-mirror / Step: S04
-- Migration: Fix API gateway path-template regex escaping
-- Purpose: Ensure {param} segments match correctly in api_match_path_template/api_extract_path_params/specificity scoring.
-- Date: 2025-12-25

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.api_match_path_template(p_path TEXT, p_template TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_path TEXT := public.normalize_api_path(p_path);
  v_template TEXT := public.normalize_api_path(p_template);
  v_path_parts TEXT[];
  v_tpl_parts TEXT[];
  v_i INT;
  v_tpl_seg TEXT;
BEGIN
  v_path_parts := string_to_array(trim(both '/' FROM v_path), '/');
  v_tpl_parts := string_to_array(trim(both '/' FROM v_template), '/');

  IF array_length(v_path_parts, 1) IS DISTINCT FROM array_length(v_tpl_parts, 1) THEN
    RETURN FALSE;
  END IF;

  FOR v_i IN 1..COALESCE(array_length(v_tpl_parts, 1), 0) LOOP
    v_tpl_seg := v_tpl_parts[v_i];
    IF v_tpl_seg ~ '^\{[A-Za-z0-9_]+\}$' THEN
      IF v_path_parts[v_i] IS NULL OR v_path_parts[v_i] = '' THEN
        RETURN FALSE;
      END IF;
    ELSE
      IF v_path_parts[v_i] IS DISTINCT FROM v_tpl_seg THEN
        RETURN FALSE;
      END IF;
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.api_extract_path_params(p_path TEXT, p_template TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_path TEXT := public.normalize_api_path(p_path);
  v_template TEXT := public.normalize_api_path(p_template);
  v_path_parts TEXT[];
  v_tpl_parts TEXT[];
  v_i INT;
  v_tpl_seg TEXT;
  v_name TEXT;
  v_out JSONB := '{}'::jsonb;
BEGIN
  IF NOT public.api_match_path_template(v_path, v_template) THEN
    RETURN '{}'::jsonb;
  END IF;

  v_path_parts := string_to_array(trim(both '/' FROM v_path), '/');
  v_tpl_parts := string_to_array(trim(both '/' FROM v_template), '/');

  FOR v_i IN 1..COALESCE(array_length(v_tpl_parts, 1), 0) LOOP
    v_tpl_seg := v_tpl_parts[v_i];
    IF v_tpl_seg ~ '^\{[A-Za-z0-9_]+\}$' THEN
      v_name := regexp_replace(v_tpl_seg, '^\{([A-Za-z0-9_]+)\}$', '\1');
      v_out := v_out || jsonb_build_object(v_name, v_path_parts[v_i]);
    END IF;
  END LOOP;

  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.api_path_template_specificity_score(p_template TEXT)
RETURNS INT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_template TEXT := public.normalize_api_path(p_template);
  v_parts TEXT[];
  v_i INT;
  v_score INT := 0;
  v_seg TEXT;
BEGIN
  v_parts := string_to_array(trim(both '/' FROM v_template), '/');
  FOR v_i IN 1..COALESCE(array_length(v_parts, 1), 0) LOOP
    v_seg := v_parts[v_i];
    IF v_seg ~ '^\{[A-Za-z0-9_]+\}$' THEN
      v_score := v_score + 0;
    ELSE
      v_score := v_score + 10;
    END IF;
  END LOOP;
  v_score := v_score + COALESCE(array_length(v_parts, 1), 0);
  RETURN v_score;
END;
$$;

COMMIT;

