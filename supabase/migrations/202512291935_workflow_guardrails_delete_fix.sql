-- Migration: Fix workflow guardrails trigger return on DELETE
-- Purpose: ensure enforce_workflow_guardrails() returns OLD for TG_OP='DELETE' so guarded tables remain deletable.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.enforce_workflow_guardrails()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_guard public.workflow_guardrails%ROWTYPE;
    v_key TEXT;
    v_context TEXT;
    v_row JSONB;
    v_match_col TEXT;
    v_expected TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_row := to_jsonb(OLD);
    ELSE
        v_row := to_jsonb(NEW);
    END IF;

    SELECT *
      INTO v_guard
      FROM public.workflow_guardrails
     WHERE resource_table = TG_TABLE_NAME
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    IF v_guard.enforcement_mode <> 'enforce' THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    IF v_guard.enforce_on IS NOT NULL AND array_length(v_guard.enforce_on, 1) IS NOT NULL THEN
        IF NOT (TG_OP = ANY(v_guard.enforce_on)) THEN
            RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END IF;
    END IF;

    IF v_guard.allow_roles IS NOT NULL AND current_user = ANY(v_guard.allow_roles) THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    FOREACH v_key IN ARRAY COALESCE(v_guard.required_context_keys, ARRAY[]::TEXT[]) LOOP
        BEGIN
            v_context := current_setting('app.' || v_key, true);
        EXCEPTION
            WHEN others THEN
                v_context := NULL;
        END;

        IF v_context IS NULL OR btrim(v_context) = '' THEN
            RAISE EXCEPTION 'workflow guardrails: missing context % for %.%', v_key, TG_TABLE_SCHEMA, TG_TABLE_NAME;
        END IF;

        v_match_col := NULL;
        IF v_guard.context_match ? v_key THEN
            v_match_col := v_guard.context_match->>v_key;
        END IF;

        IF v_match_col IS NOT NULL AND btrim(v_match_col) <> '' THEN
            v_expected := v_row->>v_match_col;
        ELSE
            v_expected := v_row->>v_key;
        END IF;

        IF v_expected IS NOT NULL AND btrim(v_expected) <> '' AND v_expected <> v_context THEN
            RAISE EXCEPTION 'workflow guardrails: context % mismatch for %.%', v_key, TG_TABLE_SCHEMA, TG_TABLE_NAME;
        END IF;
    END LOOP;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

COMMIT;

