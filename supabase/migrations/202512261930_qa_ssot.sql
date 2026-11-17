-- Migration: QA SSOT schema (runs, steps, cases, results)
-- Purpose: Centralize test run metadata and case outcomes in a dedicated schema with RLS + dynamic access.

BEGIN;

CREATE SCHEMA IF NOT EXISTS qa;

SET search_path TO qa, public, extensions, pg_temp;

CREATE TABLE IF NOT EXISTS qa.qa_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    duration_ms INTEGER,
    request_context_id UUID REFERENCES public.request_contexts(id),
    ci_provider TEXT,
    git_sha TEXT,
    git_ref TEXT,
    triggered_by TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_summary TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT qa_runs_status_check CHECK (status IN ('running', 'passed', 'failed', 'skipped', 'canceled'))
);

COMMENT ON TABLE qa.qa_runs IS 'QA run ledger (SSOT). One row per verify execution.';

CREATE INDEX IF NOT EXISTS qa_runs_key_started_idx ON qa.qa_runs (run_key, started_at DESC);
CREATE INDEX IF NOT EXISTS qa_runs_status_idx ON qa.qa_runs (status, started_at DESC);
CREATE INDEX IF NOT EXISTS qa_runs_started_idx ON qa.qa_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS qa.qa_run_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES qa.qa_runs(id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    duration_ms INTEGER,
    error_summary TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT qa_run_steps_status_check CHECK (status IN ('running', 'passed', 'failed', 'skipped', 'canceled'))
);

COMMENT ON TABLE qa.qa_run_steps IS 'QA pipeline steps for each run.';

CREATE INDEX IF NOT EXISTS qa_run_steps_run_idx ON qa.qa_run_steps (run_id, step_key);
CREATE INDEX IF NOT EXISTS qa_run_steps_status_idx ON qa.qa_run_steps (status, started_at DESC);

CREATE TABLE IF NOT EXISTS qa.qa_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    suite_key TEXT NOT NULL,
    case_key TEXT NOT NULL,
    handler_key TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    input JSONB NOT NULL DEFAULT '{}'::jsonb,
    expected JSONB,
    assertions JSONB,
    tags TEXT[],
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT qa_cases_unique UNIQUE (suite_key, case_key)
);

COMMENT ON TABLE qa.qa_cases IS 'Row-driven QA case definitions.';

CREATE INDEX IF NOT EXISTS qa_cases_suite_idx ON qa.qa_cases (suite_key, enabled);

CREATE TABLE IF NOT EXISTS qa.qa_case_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES qa.qa_runs(id) ON DELETE CASCADE,
    case_id UUID REFERENCES qa.qa_cases(id) ON DELETE SET NULL,
    suite_key TEXT NOT NULL,
    case_key TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    duration_ms INTEGER,
    observed JSONB,
    expected JSONB,
    diff JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_summary TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT qa_case_results_status_check CHECK (status IN ('passed', 'failed', 'skipped'))
);

COMMENT ON TABLE qa.qa_case_results IS 'Per-case outcomes for a QA run.';

CREATE INDEX IF NOT EXISTS qa_case_results_run_idx ON qa.qa_case_results (run_id, suite_key);
CREATE INDEX IF NOT EXISTS qa_case_results_status_idx ON qa.qa_case_results (status, started_at DESC);

CREATE TABLE IF NOT EXISTS qa.qa_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID REFERENCES qa.qa_runs(id) ON DELETE CASCADE,
    step_id UUID REFERENCES qa.qa_run_steps(id) ON DELETE SET NULL,
    case_result_id UUID REFERENCES qa.qa_case_results(id) ON DELETE SET NULL,
    artifact_key TEXT NOT NULL,
    storage_url TEXT,
    sha256 TEXT,
    bytes INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE qa.qa_artifacts IS 'Artifact registry for QA runs (logs, reports).';

CREATE INDEX IF NOT EXISTS qa_artifacts_run_idx ON qa.qa_artifacts (run_id, artifact_key);

CREATE TABLE IF NOT EXISTS qa.qa_quarantines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID REFERENCES qa.qa_cases(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    owner TEXT,
    expires_at TIMESTAMPTZ,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE qa.qa_quarantines IS 'QA quarantine registry for flaky or blocked cases.';

CREATE INDEX IF NOT EXISTS qa_quarantines_case_idx ON qa.qa_quarantines (case_id, enabled);

CREATE TABLE IF NOT EXISTS qa.qa_access_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_type TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT qa_access_roles_user_type_unique UNIQUE (user_type)
);

COMMENT ON TABLE qa.qa_access_roles IS 'Allowed user_type values for QA read access.';

INSERT INTO qa.qa_access_roles (user_type, enabled, notes)
VALUES
    ('ops_admin', true, 'Default QA reader role'),
    ('super_admin', true, 'Default QA reader role')
ON CONFLICT (user_type) DO NOTHING;

CREATE OR REPLACE FUNCTION qa.qa_is_service_role()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO qa, public, extensions, pg_temp
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
SET search_path TO qa, public, extensions, pg_temp
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
SET search_path TO qa, public, extensions, pg_temp
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
SET search_path TO qa, public, extensions, pg_temp
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
SET search_path TO qa, public, extensions, pg_temp
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
SET search_path TO qa, public, extensions, pg_temp
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
SET search_path TO qa, public, extensions, pg_temp
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

ALTER TABLE qa.qa_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa.qa_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa.qa_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa.qa_case_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa.qa_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa.qa_quarantines ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa.qa_access_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY qa_runs_read ON qa.qa_runs
    FOR SELECT TO authenticated
    USING (qa.qa_can_read());

CREATE POLICY qa_runs_service ON qa.qa_runs
    FOR ALL TO service_role
    USING (qa.qa_is_service_role())
    WITH CHECK (qa.qa_is_service_role());

CREATE POLICY qa_run_steps_read ON qa.qa_run_steps
    FOR SELECT TO authenticated
    USING (qa.qa_can_read());

CREATE POLICY qa_run_steps_service ON qa.qa_run_steps
    FOR ALL TO service_role
    USING (qa.qa_is_service_role())
    WITH CHECK (qa.qa_is_service_role());

CREATE POLICY qa_cases_read ON qa.qa_cases
    FOR SELECT TO authenticated
    USING (qa.qa_can_read());

CREATE POLICY qa_cases_service ON qa.qa_cases
    FOR ALL TO service_role
    USING (qa.qa_is_service_role())
    WITH CHECK (qa.qa_is_service_role());

CREATE POLICY qa_case_results_read ON qa.qa_case_results
    FOR SELECT TO authenticated
    USING (qa.qa_can_read());

CREATE POLICY qa_case_results_service ON qa.qa_case_results
    FOR ALL TO service_role
    USING (qa.qa_is_service_role())
    WITH CHECK (qa.qa_is_service_role());

CREATE POLICY qa_artifacts_read ON qa.qa_artifacts
    FOR SELECT TO authenticated
    USING (qa.qa_can_read());

CREATE POLICY qa_artifacts_service ON qa.qa_artifacts
    FOR ALL TO service_role
    USING (qa.qa_is_service_role())
    WITH CHECK (qa.qa_is_service_role());

CREATE POLICY qa_quarantines_read ON qa.qa_quarantines
    FOR SELECT TO authenticated
    USING (qa.qa_can_read());

CREATE POLICY qa_quarantines_service ON qa.qa_quarantines
    FOR ALL TO service_role
    USING (qa.qa_is_service_role())
    WITH CHECK (qa.qa_is_service_role());

CREATE POLICY qa_access_roles_read ON qa.qa_access_roles
    FOR SELECT TO authenticated
    USING (TRUE);

CREATE POLICY qa_access_roles_service ON qa.qa_access_roles
    FOR ALL TO service_role
    USING (qa.qa_is_service_role())
    WITH CHECK (qa.qa_is_service_role());

REVOKE ALL ON SCHEMA qa FROM PUBLIC;
GRANT USAGE ON SCHEMA qa TO authenticated, service_role;

REVOKE ALL ON ALL TABLES IN SCHEMA qa FROM PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA qa TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA qa TO service_role;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA qa FROM PUBLIC;
GRANT EXECUTE ON FUNCTION qa.qa_start_run(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION qa.qa_finish_run(UUID, TEXT, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION qa.qa_start_step(UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION qa.qa_finish_step(UUID, TEXT, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION qa.qa_record_case_results(UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION qa.qa_can_read() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION qa.qa_is_service_role() TO authenticated, service_role;

CREATE OR REPLACE VIEW qa.qa_run_summary_v AS
SELECT
    r.id,
    r.run_key,
    r.status,
    r.started_at,
    r.ended_at,
    r.duration_ms,
    r.ci_provider,
    r.git_sha,
    r.git_ref,
    r.triggered_by,
    COALESCE(s.total_steps, 0) AS total_steps,
    COALESCE(s.steps_passed, 0) AS steps_passed,
    COALESCE(s.steps_failed, 0) AS steps_failed,
    COALESCE(s.steps_skipped, 0) AS steps_skipped,
    COALESCE(c.total_cases, 0) AS total_cases,
    COALESCE(c.cases_passed, 0) AS cases_passed,
    COALESCE(c.cases_failed, 0) AS cases_failed,
    COALESCE(c.cases_skipped, 0) AS cases_skipped
FROM qa.qa_runs r
LEFT JOIN (
    SELECT
        run_id,
        COUNT(*) AS total_steps,
        COUNT(*) FILTER (WHERE status = 'passed') AS steps_passed,
        COUNT(*) FILTER (WHERE status = 'failed') AS steps_failed,
        COUNT(*) FILTER (WHERE status = 'skipped') AS steps_skipped
    FROM qa.qa_run_steps
    GROUP BY run_id
) s ON s.run_id = r.id
LEFT JOIN (
    SELECT
        run_id,
        COUNT(*) AS total_cases,
        COUNT(*) FILTER (WHERE status = 'passed') AS cases_passed,
        COUNT(*) FILTER (WHERE status = 'failed') AS cases_failed,
        COUNT(*) FILTER (WHERE status = 'skipped') AS cases_skipped
    FROM qa.qa_case_results
    GROUP BY run_id
) c ON c.run_id = r.id;

ALTER VIEW qa.qa_run_summary_v SET (security_invoker = true);

CREATE OR REPLACE VIEW qa.qa_latest_run_v AS
SELECT *
FROM qa.qa_runs
ORDER BY started_at DESC
LIMIT 1;

ALTER VIEW qa.qa_latest_run_v SET (security_invoker = true);

COMMIT;
