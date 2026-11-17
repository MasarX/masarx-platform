-- Migration: QA security definer search_path fix
-- Purpose: Pin QA security definer functions to safe search_path entries (public, extensions, pg_temp).

BEGIN;

CREATE OR REPLACE FUNCTION qa.qa_is_service_role()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_claims JSONB;
BEGIN
    IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
        RETURN TRUE;
    END IF;

    BEGIN
        v_claims := current_setting('request.jwt.claims', true)::jsonb;
    EXCEPTION
        WHEN others THEN
            v_claims := NULL;
    END;

    RETURN v_claims IS NOT NULL AND v_claims->>'role' = 'service_role';
END;
$$;

COMMENT ON FUNCTION qa.qa_is_service_role IS 'Returns true when invoked by service_role/postgres contexts.';

CREATE OR REPLACE FUNCTION qa.qa_can_read()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_user_id UUID;
    v_user_type TEXT;
BEGIN
    IF qa.qa_is_service_role() THEN
        RETURN TRUE;
    END IF;

    SELECT auth.uid() INTO v_user_id;
    IF v_user_id IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT u.user_type
    INTO v_user_type
    FROM public.users AS u
    WHERE u.id = v_user_id;

    IF v_user_type IS NULL THEN
        RETURN FALSE;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM qa.qa_access_roles r
        WHERE r.user_type = v_user_type
          AND r.enabled = TRUE
    );
END;
$$;

COMMENT ON FUNCTION qa.qa_can_read IS 'Returns true when current user can read QA tables (service_role or allowed user_type).';

CREATE OR REPLACE FUNCTION qa.qa_start_run(
    p_run_key TEXT,
    p_ci_provider TEXT DEFAULT NULL,
    p_git_sha TEXT DEFAULT NULL,
    p_git_ref TEXT DEFAULT NULL,
    p_triggered_by TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb,
    p_request_context_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_run_id UUID;
    v_request_context_id UUID;
BEGIN
    IF NOT qa.qa_is_service_role() THEN
        RAISE EXCEPTION 'qa_start_run requires service_role context';
    END IF;

    v_request_context_id := COALESCE(
        p_request_context_id,
        public.create_request_context('qa_runner', 'qa')
    );

    INSERT INTO qa.qa_runs (
        run_key,
        status,
        started_at,
        request_context_id,
        ci_provider,
        git_sha,
        git_ref,
        triggered_by,
        metadata
    ) VALUES (
        p_run_key,
        'running',
        now(),
        v_request_context_id,
        NULLIF(p_ci_provider, ''),
        NULLIF(p_git_sha, ''),
        NULLIF(p_git_ref, ''),
        NULLIF(p_triggered_by, ''),
        COALESCE(p_metadata, '{}'::jsonb)
    )
    RETURNING id INTO v_run_id;

    RETURN v_run_id;
END;
$$;

COMMENT ON FUNCTION qa.qa_start_run(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, UUID)
  IS 'Start a QA run and return the run_id.';

CREATE OR REPLACE FUNCTION qa.qa_finish_run(
    p_run_id UUID,
    p_status TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb,
    p_error_summary TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_request_context_id UUID;
    v_error BOOLEAN := FALSE;
BEGIN
    IF NOT qa.qa_is_service_role() THEN
        RAISE EXCEPTION 'qa_finish_run requires service_role context';
    END IF;

    UPDATE qa.qa_runs
    SET
        status = p_status,
        ended_at = now(),
        duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000,
        error_summary = NULLIF(p_error_summary, ''),
        metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb))
    WHERE id = p_run_id
    RETURNING request_context_id INTO v_request_context_id;

    v_error := COALESCE(p_status, '') NOT IN ('passed', 'skipped');

    IF v_request_context_id IS NOT NULL THEN
        PERFORM public.complete_request_context(v_request_context_id, v_error, 0);
    END IF;
END;
$$;

COMMENT ON FUNCTION qa.qa_finish_run(UUID, TEXT, JSONB, TEXT)
  IS 'Finish a QA run and update duration/error metadata.';

CREATE OR REPLACE FUNCTION qa.qa_start_step(
    p_run_id UUID,
    p_step_key TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_step_id UUID;
BEGIN
    IF NOT qa.qa_is_service_role() THEN
        RAISE EXCEPTION 'qa_start_step requires service_role context';
    END IF;

    INSERT INTO qa.qa_run_steps (
        run_id,
        step_key,
        status,
        started_at,
        metadata
    ) VALUES (
        p_run_id,
        p_step_key,
        'running',
        now(),
        COALESCE(p_metadata, '{}'::jsonb)
    )
    RETURNING id INTO v_step_id;

    RETURN v_step_id;
END;
$$;

COMMENT ON FUNCTION qa.qa_start_step(UUID, TEXT, JSONB)
  IS 'Record the start of a QA pipeline step.';

CREATE OR REPLACE FUNCTION qa.qa_finish_step(
    p_step_id UUID,
    p_status TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb,
    p_error_summary TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
    IF NOT qa.qa_is_service_role() THEN
        RAISE EXCEPTION 'qa_finish_step requires service_role context';
    END IF;

    UPDATE qa.qa_run_steps
    SET
        status = p_status,
        ended_at = now(),
        duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000,
        error_summary = NULLIF(p_error_summary, ''),
        metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb))
    WHERE id = p_step_id;
END;
$$;

COMMENT ON FUNCTION qa.qa_finish_step(UUID, TEXT, JSONB, TEXT)
  IS 'Finish a QA pipeline step and set status/duration.';

CREATE OR REPLACE FUNCTION qa.qa_record_case_results(
    p_run_id UUID,
    p_suite_key TEXT,
    p_results JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_inserted INTEGER := 0;
BEGIN
    IF NOT qa.qa_is_service_role() THEN
        RAISE EXCEPTION 'qa_record_case_results requires service_role context';
    END IF;

    INSERT INTO qa.qa_case_results (
        run_id,
        case_id,
        suite_key,
        case_key,
        status,
        started_at,
        ended_at,
        duration_ms,
        observed,
        expected,
        diff,
        metadata,
        error_summary
    )
    SELECT
        p_run_id,
        c.id,
        p_suite_key,
        r.case_key,
        r.status,
        COALESCE(r.started_at, now()),
        r.ended_at,
        r.duration_ms,
        r.observed,
        r.expected,
        r.diff,
        COALESCE(r.metadata, '{}'::jsonb),
        r.error_summary
    FROM jsonb_to_recordset(COALESCE(p_results, '[]'::jsonb)) AS r(
        case_key TEXT,
        status TEXT,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        duration_ms INTEGER,
        observed JSONB,
        expected JSONB,
        diff JSONB,
        metadata JSONB,
        error_summary TEXT
    )
    LEFT JOIN qa.qa_cases c
      ON c.suite_key = p_suite_key
     AND c.case_key = r.case_key;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted;
END;
$$;

COMMENT ON FUNCTION qa.qa_record_case_results(UUID, TEXT, JSONB)
  IS 'Bulk insert QA case results for a run/suite.';

COMMIT;
