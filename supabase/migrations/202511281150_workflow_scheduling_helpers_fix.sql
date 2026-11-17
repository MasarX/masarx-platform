-- Migration: Workflow scheduling helpers fix
-- Purpose:
--   - Ensure scheduling helper functions exist in environments where the original
--     2025101705_workflow_scheduling.sql migration partially failed or was skipped.
--   - Functions are defined once, in public schema, with search_path pinned to
--     (public, pg_temp) to avoid search_path-related runtime issues.

BEGIN;

-- workflow_schedule_timezone: resolve timezone from schedule metadata
CREATE OR REPLACE FUNCTION public.workflow_schedule_timezone(p_schedule JSONB)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path TO public, pg_temp
AS $function$
BEGIN
    RETURN COALESCE(NULLIF(p_schedule->>'timezone', ''), 'UTC');
END;
$function$;

-- workflow_adjust_for_quiet_hours: move candidate time out of configured quiet windows
CREATE OR REPLACE FUNCTION public.workflow_adjust_for_quiet_hours(
    p_candidate TIMESTAMPTZ,
    p_schedule JSONB
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_timezone TEXT := workflow_schedule_timezone(p_schedule);
    v_quiet JSONB := COALESCE(p_schedule->'quiet_hours', '[]'::jsonb);
    v_adjusted TIMESTAMPTZ := p_candidate;
    v_iteration INT := 0;
    v_local TIMESTAMP;
    v_local_time TIME;
    v_local_date DATE;
    v_local_dow INT;
    v_entry RECORD;
    v_days JSONB;
    v_day_match BOOLEAN;
    v_start_text TEXT;
    v_end_text TEXT;
    v_start TIME;
    v_end TIME;
    v_new_local TIMESTAMP;
    v_in_quiet BOOLEAN;
    v_day_value TEXT;
    v_day_int INT;
BEGIN
    LOOP
        v_iteration := v_iteration + 1;
        EXIT WHEN v_iteration > 14;

        v_local := v_adjusted AT TIME ZONE v_timezone;
        v_local_time := v_local::time;
        v_local_date := v_local::date;
        v_local_dow := EXTRACT(DOW FROM v_local)::INT;

        v_in_quiet := FALSE;

        FOR v_entry IN
            SELECT value
            FROM jsonb_array_elements(v_quiet)
        LOOP
            v_days := v_entry.value->'days';
            v_day_match := TRUE;

            IF v_days IS NOT NULL THEN
                v_day_match := FALSE;
                FOR v_day_value IN
                    SELECT value::text
                    FROM jsonb_array_elements_text(v_days)
                LOOP
                    BEGIN
                        v_day_int := CASE
                            WHEN v_day_value ~ '^[0-6]$' THEN v_day_value::INT
                            WHEN lower(v_day_value) IN ('sun', 'sunday') THEN 0
                            WHEN lower(v_day_value) IN ('mon', 'monday') THEN 1
                            WHEN lower(v_day_value) IN ('tue', 'tuesday') THEN 2
                            WHEN lower(v_day_value) IN ('wed', 'wednesday') THEN 3
                            WHEN lower(v_day_value) IN ('thu', 'thursday') THEN 4
                            WHEN lower(v_day_value) IN ('fri', 'friday') THEN 5
                            WHEN lower(v_day_value) IN ('sat', 'saturday') THEN 6
                            ELSE NULL
                        END;
                    EXCEPTION
                        WHEN others THEN
                            v_day_int := NULL;
                    END;

                    IF v_day_int IS NOT NULL AND v_day_int = v_local_dow THEN
                        v_day_match := TRUE;
                        EXIT;
                    END IF;
                END LOOP;
            END IF;

            IF NOT v_day_match THEN
                CONTINUE;
            END IF;

            v_start_text := v_entry.value->>'start';
            v_end_text := v_entry.value->>'end';

            IF v_start_text IS NULL OR v_end_text IS NULL THEN
                CONTINUE;
            END IF;

            BEGIN
                v_start := v_start_text::time;
                v_end := v_end_text::time;
            EXCEPTION
                WHEN others THEN
                    CONTINUE;
            END;

            IF v_start <= v_end THEN
                IF v_local_time >= v_start AND v_local_time < v_end THEN
                    v_in_quiet := TRUE;
                    v_new_local := v_local_date::timestamp + v_end;
                END IF;
            ELSE
                IF v_local_time >= v_start OR v_local_time < v_end THEN
                    v_in_quiet := TRUE;
                    IF v_local_time >= v_start THEN
                        v_new_local := (v_local_date + 1)::timestamp + v_end;
                    ELSE
                        v_new_local := v_local_date::timestamp + v_end;
                    END IF;
                END IF;
            END IF;

            IF v_in_quiet THEN
                v_adjusted := timezone(v_timezone, v_new_local);
                EXIT;
            END IF;
        END LOOP;

        EXIT WHEN NOT v_in_quiet;
    END LOOP;

    RETURN v_adjusted;
END;
$function$;

-- workflow_compute_run_at: compute next run time given metadata & runtime state
CREATE OR REPLACE FUNCTION public.workflow_compute_run_at(
    p_reference TIMESTAMPTZ,
    p_metadata JSONB,
    p_runtime_state JSONB,
    p_attempt INTEGER,
    p_is_retry BOOLEAN
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_schedule JSONB := COALESCE(p_metadata->'schedule', '{}'::jsonb);
    v_timezone TEXT := workflow_schedule_timezone(v_schedule);
    v_delay_seconds INT := 0;
    v_candidate TIMESTAMPTZ := p_reference;
    v_backoff JSONB;
    v_idx INT;
    v_delay_text TEXT;
    v_max_per_day INT;
    v_state_date TEXT;
    v_state_attempts INT;
    v_reference_local TIMESTAMP;
    v_reference_date TEXT;
BEGIN
    IF NOT p_is_retry THEN
        v_delay_seconds := COALESCE(
            NULLIF(p_metadata->>'delay_seconds', '')::INT,
            NULLIF(v_schedule->>'initial_delay_seconds', '')::INT,
            0
        );
    ELSE
        v_backoff := v_schedule->'retry_backoff_seconds';

        IF v_backoff IS NOT NULL AND jsonb_typeof(v_backoff) = 'array' AND jsonb_array_length(v_backoff) > 0 THEN
            v_idx := LEAST(jsonb_array_length(v_backoff), GREATEST(1, p_attempt - 1));
            SELECT value
            INTO v_delay_text
            FROM jsonb_array_elements_text(v_backoff) WITH ORDINALITY AS arr(value, idx)
            WHERE idx = v_idx;

            BEGIN
                v_delay_seconds := COALESCE(v_delay_text::INT, 0);
            EXCEPTION
                WHEN others THEN
                    v_delay_seconds := 0;
            END;
        END IF;

        IF v_delay_seconds IS NULL OR v_delay_seconds = 0 THEN
            v_delay_seconds := COALESCE(
                NULLIF(v_schedule->>'retry_default_delay_seconds', '')::INT,
                NULLIF(v_schedule->>'repeat_delay_seconds', '')::INT,
                COALESCE(
                    NULLIF(p_metadata->>'retry_delay_seconds', '')::INT,
                    0
                )
            );
        END IF;
    END IF;

    v_candidate := p_reference + make_interval(secs => COALESCE(v_delay_seconds, 0));

    IF p_is_retry THEN
        v_max_per_day := NULLIF(v_schedule->>'max_attempts_per_day', '')::INT;
        IF v_max_per_day IS NOT NULL THEN
            v_state_date := COALESCE(p_runtime_state->>'attempt_date', NULL);
            v_state_attempts := COALESCE((p_runtime_state->>'attempts_today')::INT, 0);
            v_reference_local := p_reference AT TIME ZONE v_timezone;
            v_reference_date := to_char(v_reference_local::date, 'YYYY-MM-DD');

            IF v_state_date = v_reference_date AND v_state_attempts >= v_max_per_day THEN
                v_candidate := timezone(
                    v_timezone,
                    (v_reference_local::date + 1)::timestamp
                );
            END IF;
        END IF;
    END IF;

    RETURN workflow_adjust_for_quiet_hours(v_candidate, v_schedule);
END;
$function$;

-- workflow_record_attempt_state: maintain attempts_today and last_attempt_at in runtime_state
CREATE OR REPLACE FUNCTION public.workflow_record_attempt_state(
    p_state JSONB,
    p_metadata JSONB,
    p_attempt_time TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_schedule JSONB := COALESCE(p_metadata->'schedule', '{}'::jsonb);
    v_timezone TEXT := workflow_schedule_timezone(v_schedule);
    v_state JSONB := COALESCE(p_state, '{}'::jsonb);
    v_local TIMESTAMP := p_attempt_time AT TIME ZONE v_timezone;
    v_date TEXT := to_char(v_local::date, 'YYYY-MM-DD');
    v_prev_date TEXT := v_state->>'attempt_date';
    v_attempts_today INT := 1;
BEGIN
    IF v_prev_date = v_date THEN
        v_attempts_today := COALESCE((v_state->>'attempts_today')::INT, 0) + 1;
    END IF;

    v_state := jsonb_set(v_state, '{timezone}', to_jsonb(v_timezone), TRUE);
    v_state := jsonb_set(v_state, '{attempt_date}', to_jsonb(v_date), TRUE);
    v_state := jsonb_set(v_state, '{attempts_today}', to_jsonb(v_attempts_today), TRUE);
    v_state := jsonb_set(v_state, '{last_attempt_at}', to_jsonb(p_attempt_time), TRUE);

    RETURN v_state;
END;
$function$;

-- workflow_should_stop: evaluate stop_when conditions on run context / metadata
CREATE OR REPLACE FUNCTION public.workflow_should_stop(
    p_run_context JSONB,
    p_step_metadata JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_conditions JSONB := COALESCE(p_step_metadata->'stop_when', '[]'::jsonb);
    v_entry RECORD;
    v_path TEXT;
    v_expected JSONB;
    v_scope TEXT;
    v_source JSONB;
    v_actual JSONB;
    v_reason TEXT;
BEGIN
    FOR v_entry IN
        SELECT value
        FROM jsonb_array_elements(v_conditions)
    LOOP
        v_path := v_entry.value->>'path';
        IF v_path IS NULL OR trim(v_path) = '' THEN
            CONTINUE;
        END IF;

        v_scope := COALESCE(NULLIF(v_entry.value->>'scope', ''), 'context');

        IF v_scope = 'context' THEN
            v_source := COALESCE(p_run_context, '{}'::jsonb);
        ELSE
            v_source := COALESCE(p_step_metadata, '{}'::jsonb);
        END IF;

        v_actual := safe_jsonpath_query_first(v_source, v_path);

        IF v_entry.value ? 'equals' THEN
            v_expected := v_entry.value->'equals';
            IF v_expected IS NULL THEN
                IF v_actual IS NULL THEN
                    v_reason := COALESCE(v_entry.value->>'reason', format('stop_when matched NULL at path %s', v_path));
                    RETURN jsonb_build_object(
                        'stop', TRUE,
                        'reason', v_reason,
                        'path', v_path
                    );
                END IF;
            ELSIF v_actual IS NOT NULL AND v_actual = v_expected THEN
                v_reason := COALESCE(v_entry.value->>'reason', format('stop_when matched path %s', v_path));
                RETURN jsonb_build_object(
                    'stop', TRUE,
                    'reason', v_reason,
                    'path', v_path,
                    'expected', v_expected,
                    'actual', v_actual
                );
            END IF;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('stop', FALSE);
END;
$function$;

COMMIT;

