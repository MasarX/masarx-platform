-- Migration: Archive old RANGE partitions (policy-driven)
-- Purpose: Implement detachment and archive/delete of old RANGE partitions per partitioning_config
-- Date: 2025-11-23 14:20

BEGIN;

CREATE OR REPLACE FUNCTION public.archive_old_partitions()
RETURNS TABLE (
    table_name TEXT,
    partition_name TEXT,
    row_count BIGINT,
    detached BOOLEAN,
    archived_to TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_conf RECORD;
    v_cutoff TIMESTAMPTZ;
    v_policy TEXT;
    v_parent_oid OID;
    v_parent_name TEXT;
    r_part RECORD;
    v_row_count BIGINT;
    v_archived_to TEXT;
    v_part_end TIMESTAMPTZ;
    v_part_end_raw TEXT;
    v_action TEXT;
    v_outcome TEXT;
    v_err TEXT;
BEGIN
    -- Iterate configured RANGE and HASH+RANGE tables with retention
    FOR v_conf IN
        SELECT
            pc.table_name,
            pc.partition_strategy,
            pc.retention_months,
            COALESCE(pc.config->>'retention_policy','archive') AS retention_policy
        FROM partitioning_config pc
        WHERE pc.partition_strategy IN ('RANGE','HASH+RANGE')
          AND pc.retention_months IS NOT NULL
        ORDER BY pc.table_name
    LOOP
        v_cutoff := now() - (v_conf.retention_months || ' months')::interval;
        v_policy := v_conf.retention_policy;

        -- Helper to process one parent (hash parent or base table for RANGE-only)
        -- Gathers all RANGE partitions under v_parent_oid and archives/drops those older than cutoff
        PERFORM 1;

        -- Identify parent(s)
        IF v_conf.partition_strategy = 'HASH+RANGE' THEN
            -- Each HASH partition under the base table can own RANGE children
            FOR v_parent_oid, v_parent_name IN
                SELECT c.oid, c.relname
                FROM pg_class c
                JOIN pg_inherits i ON i.inhrelid = c.oid
                JOIN pg_class p ON p.oid = i.inhparent
                WHERE p.relname = v_conf.table_name
            LOOP
                -- Process all RANGE children of this hash parent
                FOR r_part IN
                    SELECT c.relname AS part_name,
                           c.oid AS part_oid,
                           pg_get_expr(c.relpartbound, c.oid) AS part_expr
                    FROM pg_class c
                    JOIN pg_inherits i ON i.inhrelid = c.oid
                    WHERE i.inhparent = v_parent_oid
                      AND c.relkind = 'r'
                LOOP
                    -- Parse TO(...) bound as partition end
                    v_part_end := NULL;
                    v_part_end_raw := NULL;
                    BEGIN
                        SELECT regexp_replace((regexp_matches(r_part.part_expr, 'TO \(([^\)]+)\)'))[1], '^''|''$', '', 'g')
                          INTO v_part_end_raw;
                        IF v_part_end_raw IS NOT NULL THEN
                            v_part_end := v_part_end_raw::timestamptz;
                        END IF;
                    EXCEPTION WHEN OTHERS THEN
                        v_part_end := NULL;
                    END;

                    -- Skip partitions without parsable bounds or within retention window
                    IF v_part_end IS NULL OR v_part_end >= v_cutoff THEN
                        CONTINUE;
                    END IF;

                    -- Row count (pre-detach)
                    EXECUTE format('SELECT COUNT(*) FROM %I', r_part.part_name) INTO v_row_count;

                    v_action := NULL; v_outcome := 'success'; v_err := NULL; v_archived_to := NULL;
                    BEGIN
                        IF v_policy = 'archive' THEN
                            EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', v_parent_name, r_part.part_name);
                            EXECUTE format('ALTER TABLE %I SET SCHEMA archive', r_part.part_name);
                            v_archived_to := 'archive.' || r_part.part_name;
                            v_action := 'archive';
                        ELSIF v_policy = 'delete' THEN
                            EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', v_parent_name, r_part.part_name);
                            EXECUTE format('DROP TABLE IF EXISTS %I', r_part.part_name);
                            v_archived_to := 'deleted';
                            v_action := 'delete';
                        ELSE
                            v_action := 'skip';
                        END IF;
                    EXCEPTION WHEN OTHERS THEN
                        v_outcome := 'error';
                        v_err := SQLERRM;
                    END;

                    -- Audit
                    INSERT INTO public.archiving_history (
                        table_name, partition_name, parent_name, action, retention_months,
                        policy, partition_end, row_count, outcome, error
                    ) VALUES (
                        v_conf.table_name, r_part.part_name, v_parent_name, COALESCE(v_action,'skip'),
                        v_conf.retention_months, v_policy, v_part_end, v_row_count, v_outcome, v_err
                    );

                    -- Return only processed rows (archive/delete attempted)
                    IF v_action IN ('archive','delete') THEN
                        table_name := v_conf.table_name;
                        partition_name := r_part.part_name;
                        row_count := v_row_count;
                        detached := (v_outcome = 'success');
                        archived_to := v_archived_to;
                        RETURN NEXT;
                    END IF;
                END LOOP;
            END LOOP;
        ELSE
            -- RANGE-only: direct children of the base table
            SELECT to_regclass('public.' || v_conf.table_name) INTO v_parent_oid;
            IF v_parent_oid IS NULL THEN
                CONTINUE;
            END IF;
            SELECT v_conf.table_name INTO v_parent_name;

            FOR r_part IN
                SELECT c.relname AS part_name,
                       c.oid AS part_oid,
                       pg_get_expr(c.relpartbound, c.oid) AS part_expr
                FROM pg_class c
                JOIN pg_inherits i ON i.inhrelid = c.oid
                WHERE i.inhparent = v_parent_oid
                  AND c.relkind = 'r'
            LOOP
                v_part_end := NULL; v_part_end_raw := NULL;
                BEGIN
                    SELECT regexp_replace((regexp_matches(r_part.part_expr, 'TO \(([^\)]+)\)'))[1], '^''|''$', '', 'g')
                      INTO v_part_end_raw;
                    IF v_part_end_raw IS NOT NULL THEN
                        v_part_end := v_part_end_raw::timestamptz;
                    END IF;
                EXCEPTION WHEN OTHERS THEN
                    v_part_end := NULL;
                END;

                IF v_part_end IS NULL OR v_part_end >= v_cutoff THEN
                    CONTINUE;
                END IF;

                EXECUTE format('SELECT COUNT(*) FROM %I', r_part.part_name) INTO v_row_count;

                v_action := NULL; v_outcome := 'success'; v_err := NULL; v_archived_to := NULL;
                BEGIN
                    IF v_policy = 'archive' THEN
                        EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', v_parent_name, r_part.part_name);
                        EXECUTE format('ALTER TABLE %I SET SCHEMA archive', r_part.part_name);
                        v_archived_to := 'archive.' || r_part.part_name;
                        v_action := 'archive';
                    ELSIF v_policy = 'delete' THEN
                        EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', v_parent_name, r_part.part_name);
                        EXECUTE format('DROP TABLE IF EXISTS %I', r_part.part_name);
                        v_archived_to := 'deleted';
                        v_action := 'delete';
                    ELSE
                        v_action := 'skip';
                    END IF;
                EXCEPTION WHEN OTHERS THEN
                    v_outcome := 'error';
                    v_err := SQLERRM;
                END;

                INSERT INTO public.archiving_history (
                    table_name, partition_name, parent_name, action, retention_months,
                    policy, partition_end, row_count, outcome, error
                ) VALUES (
                    v_conf.table_name, r_part.part_name, v_parent_name, COALESCE(v_action,'skip'),
                    v_conf.retention_months, v_policy, v_part_end, v_row_count, v_outcome, v_err
                );

                IF v_action IN ('archive','delete') THEN
                    table_name := v_conf.table_name;
                    partition_name := r_part.part_name;
                    row_count := v_row_count;
                    detached := (v_outcome = 'success');
                    archived_to := v_archived_to;
                    RETURN NEXT;
                END IF;
            END LOOP;
        END IF;
    END LOOP;

    RETURN;
END;
$$;

COMMENT ON FUNCTION public.archive_old_partitions() IS
    'Detach and archive/delete old RANGE partitions per partitioning_config.retention_months and config.retention_policy. Audits to archiving_history.';

COMMIT;

