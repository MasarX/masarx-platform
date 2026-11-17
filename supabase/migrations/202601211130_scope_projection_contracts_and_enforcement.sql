-- Plan: PLAN-202601-scope-projection-integrity / Step: S04
-- Migration: Scope projection contracts (row-driven) + enforcement trigger
--
-- Goal
-- - Prevent drift in denormalized scope columns (e.g., organization_id) that are used for RLS and common access paths.
-- - Keep enforcement dynamic: rules are rows in a canonical contract table; one generic trigger enforces all.
--
-- Notes
-- - Joins are currently UUID-key based (typical for scope ladder entities).
-- - Tables with nullable join keys are enforced only when the join key is present.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) Contract table: scope_projection_contracts
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scope_projection_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_schema TEXT NOT NULL DEFAULT 'public',
  table_name TEXT NOT NULL,
  parent_schema TEXT NOT NULL DEFAULT 'public',
  parent_table TEXT NOT NULL,
  join_local_cols TEXT[] NOT NULL,
  join_parent_cols TEXT[] NOT NULL,
  projections JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scope_projection_contracts_table_schema_nonempty CHECK (btrim(table_schema) <> ''),
  CONSTRAINT scope_projection_contracts_table_name_nonempty CHECK (btrim(table_name) <> ''),
  CONSTRAINT scope_projection_contracts_parent_schema_nonempty CHECK (btrim(parent_schema) <> ''),
  CONSTRAINT scope_projection_contracts_parent_table_nonempty CHECK (btrim(parent_table) <> ''),
  CONSTRAINT scope_projection_contracts_join_cols_nonempty CHECK (cardinality(join_local_cols) > 0 AND cardinality(join_parent_cols) > 0),
  CONSTRAINT scope_projection_contracts_join_cols_same_arity CHECK (cardinality(join_local_cols) = cardinality(join_parent_cols)),
  CONSTRAINT scope_projection_contracts_projections_object CHECK (jsonb_typeof(projections) = 'object' AND projections <> '{}'::jsonb),
  CONSTRAINT scope_projection_contracts_unique UNIQUE (
    table_schema,
    table_name,
    parent_schema,
    parent_table,
    join_local_cols,
    join_parent_cols
  )
);

COMMENT ON TABLE public.scope_projection_contracts IS
  'Row-driven scope projection contracts: maps derived scope columns (e.g., organization_id) to canonical parent sources via explicit join columns. Used to prevent RLS scope drift.';

ALTER TABLE public.scope_projection_contracts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.scope_projection_contracts FROM PUBLIC;
REVOKE ALL ON TABLE public.scope_projection_contracts FROM anon;
REVOKE ALL ON TABLE public.scope_projection_contracts FROM authenticated;

DROP POLICY IF EXISTS scope_projection_contracts_service_policy ON public.scope_projection_contracts;
CREATE POLICY scope_projection_contracts_service_policy
  ON public.scope_projection_contracts
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP TRIGGER IF EXISTS trg_scope_projection_contracts_set_updated_at ON public.scope_projection_contracts;
CREATE TRIGGER trg_scope_projection_contracts_set_updated_at
  BEFORE UPDATE ON public.scope_projection_contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 2) Seed baseline contracts: org_id must match client.organization_id when client_id is present
-------------------------------------------------------------------------------

INSERT INTO public.scope_projection_contracts (
  table_schema,
  table_name,
  parent_schema,
  parent_table,
  join_local_cols,
  join_parent_cols,
  projections
)
VALUES
  ('public', 'addresses', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'address_versions', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'api_gateway_requests', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'campaign_enrollments', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'comms_reply_sessions', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'geocodes', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'geocoding_alias_audit', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'geocoding_attempts', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'label_jobs', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'labels', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'manual_review_tasks', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'provider_usage_tracking', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'recipients', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'shipment_actions', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'shipment_boxes', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'shipment_reference_numbers', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb),
  ('public', 'shipments', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb)
ON CONFLICT ON CONSTRAINT scope_projection_contracts_unique DO NOTHING;

-------------------------------------------------------------------------------
-- 3) Enforcement trigger function (generic; table-driven)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_scope_projection_contracts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rec RECORD;
  v_row JSONB;
  v_parents JSONB;
  v_parent JSONB;
  v_where TEXT;
  v_sql TEXT;
  v_i INT;
  v_local_col TEXT;
  v_parent_col TEXT;
  v_key TEXT;
  v_expected TEXT;
  v_actual TEXT;
BEGIN
  v_row := to_jsonb(NEW);

  FOR rec IN
    SELECT parent_schema, parent_table, join_local_cols, join_parent_cols, projections
    FROM public.scope_projection_contracts
    WHERE table_schema = TG_TABLE_SCHEMA
      AND table_name = TG_TABLE_NAME
    ORDER BY parent_schema, parent_table
  LOOP
    IF rec.join_local_cols IS NULL OR rec.join_parent_cols IS NULL THEN
      CONTINUE;
    END IF;
    IF array_length(rec.join_local_cols, 1) IS NULL OR array_length(rec.join_parent_cols, 1) IS NULL THEN
      CONTINUE;
    END IF;

    v_where := '';
    FOR v_i IN 1..array_length(rec.join_local_cols, 1) LOOP
      v_local_col := rec.join_local_cols[v_i];
      v_parent_col := rec.join_parent_cols[v_i];

      -- Nullable join keys: only enforce when present.
      IF (v_row ->> v_local_col) IS NULL THEN
        v_where := NULL;
        EXIT;
      END IF;

      IF v_i > 1 THEN
        v_where := v_where || ' AND ';
      END IF;

      -- UUID-key joins (scope ladder IDs). If a future contract needs non-UUID join keys, extend the contract
      -- schema with explicit casts and update this function accordingly.
      v_where := v_where || format('p.%I = ($1 ->> %L)::uuid', v_parent_col, v_local_col);
    END LOOP;

    IF v_where IS NULL THEN
      CONTINUE;
    END IF;

    v_sql := format(
      'SELECT jsonb_agg(to_jsonb(p)) FROM (SELECT * FROM %I.%I p WHERE %s LIMIT 2) p',
      rec.parent_schema,
      rec.parent_table,
      v_where
    );

    v_parents := NULL;
    EXECUTE v_sql USING v_row INTO v_parents;

    IF v_parents IS NULL THEN
      RAISE EXCEPTION
        'Scope projection parent missing for %.% via %.% (join=%)',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, rec.parent_schema, rec.parent_table, array_to_string(rec.join_local_cols, ',')
        USING ERRCODE = '23514';
    END IF;

    IF jsonb_array_length(v_parents) > 1 THEN
      RAISE EXCEPTION
        'Scope projection parent not unique for %.% via %.% (join=%)',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, rec.parent_schema, rec.parent_table, array_to_string(rec.join_local_cols, ',')
        USING ERRCODE = '23514';
    END IF;

    v_parent := v_parents -> 0;

    FOR v_key IN SELECT jsonb_object_keys(rec.projections) LOOP
      v_parent_col := rec.projections ->> v_key;
      v_expected := v_parent ->> v_parent_col;
      v_actual := v_row ->> v_key;

      IF v_expected IS NULL THEN
        RAISE EXCEPTION
          'Scope projection contract invalid: %.% missing parent column "%" required for %.%.%',
          rec.parent_schema, rec.parent_table, v_parent_col, TG_TABLE_SCHEMA, TG_TABLE_NAME, v_key
          USING ERRCODE = '23514';
      END IF;

      IF v_actual IS NULL THEN
        v_row := jsonb_set(v_row, ARRAY[v_key], to_jsonb(v_expected), true);
      ELSIF v_actual IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION
          'Scope projection mismatch for %.%.%: does not match %.%.% (contract parent=%.%)',
          TG_TABLE_SCHEMA, TG_TABLE_NAME, v_key, rec.parent_schema, rec.parent_table, v_parent_col, rec.parent_schema, rec.parent_table
          USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END LOOP;

  NEW := jsonb_populate_record(NEW, v_row);
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_scope_projection_contracts()
  SET search_path = public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 4) Trigger applier (generic; attaches per-table triggers based on contract rows)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_scope_projection_contracts(p_table_schema TEXT DEFAULT 'public')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rec RECORD;
  v_cols TEXT;
  v_fq TEXT;
  v_trg TEXT;
BEGIN
  FOR rec IN
    SELECT table_schema, table_name
    FROM public.scope_projection_contracts
    WHERE table_schema = p_table_schema
    GROUP BY table_schema, table_name
    ORDER BY table_schema, table_name
  LOOP
    v_fq := format('%I.%I', rec.table_schema, rec.table_name);
    IF to_regclass(v_fq) IS NULL THEN
      CONTINUE;
    END IF;

    SELECT string_agg(DISTINCT format('%I', col), ', ' ORDER BY format('%I', col))
    INTO v_cols
    FROM (
      SELECT unnest(join_local_cols) AS col
      FROM public.scope_projection_contracts
      WHERE table_schema = rec.table_schema
        AND table_name = rec.table_name
      UNION
      SELECT jsonb_object_keys(projections) AS col
      FROM public.scope_projection_contracts
      WHERE table_schema = rec.table_schema
        AND table_name = rec.table_name
    ) cols;

    IF v_cols IS NULL OR btrim(v_cols) = '' THEN
      CONTINUE;
    END IF;

    v_trg := 'trg_scope_projection_' || substr(md5(rec.table_schema || '.' || rec.table_name), 1, 12);

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', v_trg, v_fq);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %s ON %s FOR EACH ROW EXECUTE FUNCTION public.enforce_scope_projection_contracts()',
      v_trg,
      v_cols,
      v_fq
    );
  END LOOP;
END;
$$;

ALTER FUNCTION public.apply_scope_projection_contracts(TEXT)
  SET search_path = public, extensions, pg_temp;

COMMENT ON FUNCTION public.apply_scope_projection_contracts(TEXT) IS
  'Attaches scope projection enforcement triggers for tables in scope_projection_contracts (row-driven; no per-table hardcoding).';

SELECT public.apply_scope_projection_contracts('public');

COMMIT;
