-- Test Suite: Workflow handler registry and dispatcher metadata

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SELECT has_table('public', 'operation_handlers', 'operation_handlers table exists');

SELECT ok(
    (SELECT COUNT(*) FROM operation_handlers WHERE handler_key IS NULL) = 0,
    'operation_handlers.handler_key is NOT NULL'
);

WITH expected AS (
    SELECT unnest(ARRAY[
        'outbound_http',
        'workflow_control',
        'label_job',
        'wait_for_shipment',
        'geocode_cache',
        'geo_coordinate',
        'geo_normalize',
        'provider_dispatch',
        'geo_decision',
        'geocode_manual_review_enqueue'
    ]) AS handler_key
)
SELECT ok(
    (
        SELECT COUNT(*)
        FROM expected e
        LEFT JOIN operation_handlers h
          ON h.handler_key = e.handler_key
        WHERE h.handler_key IS NULL
    ) = 0,
    'Seeded handler keys present'
);

SELECT ok(
    (
        SELECT COUNT(*)
        FROM operation_handlers
        WHERE to_regprocedure(format('%I.%I%s', handler_schema, handler_name, handler_signature)) IS NULL
    ) = 0,
    'All registered handlers resolve to existing functions'
);

SELECT ok(
    (SELECT bool_and(handler_version ~ '^v[0-9]+$') FROM operation_handlers),
    'Handler versions follow vN pattern'
);

SELECT ok(
    (SELECT COUNT(*) FROM workflow_template_steps WHERE handler_key IS NULL) = 0,
    'All workflow template steps have handler_key'
);

SELECT ok(
    (
        SELECT workflow_refresh_steps_checksum(id)
        FROM workflow_templates
        ORDER BY id
        LIMIT 1
    ) IS NOT NULL,
    'workflow_refresh_steps_checksum returns checksum'
);

SELECT ok(
    (SELECT COUNT(*) FROM workflow_run_steps WHERE handler_key IS NULL) = 0,
    'Workflow run steps copy handler assignments'
);

SELECT * FROM finish();

ROLLBACK;
