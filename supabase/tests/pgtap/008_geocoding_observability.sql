-- pgTAP: Geocoding observability, automation, and auto-learning checks

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SELECT has_view(
    'public',
    'geocoding_queue_status_v',
    'geocoding_queue_status_v view exists'
);

SELECT has_column(
    'public',
    'geocoding_queue_status_v',
    'pending_steps',
    'geocoding_queue_status_v exposes pending_steps'
);

SELECT has_view(
    'public',
    'geocoding_cache_metrics_v',
    'geocoding_cache_metrics_v view exists'
);

SELECT has_view(
    'public',
    'geocoding_provider_spend_v',
    'geocoding_provider_spend_v view exists'
);

SELECT has_function(
    'public',
    'requeue_stuck_geocoding_steps',
    ARRAY['integer','integer'],
    'requeue_stuck_geocoding_steps helper installed'
);

SELECT has_function(
    'public',
    'escalate_geocoding_manual_review',
    ARRAY['integer'],
    'escalate_geocoding_manual_review helper installed'
);

SELECT has_function(
    'public',
    'cleanup_expired_geocodes',
    ARRAY['integer'],
    'cleanup_expired_geocodes helper installed'
);

SELECT has_function(
    'public',
    'auto_learn_geography',
    ARRAY['uuid','uuid','uuid','uuid','jsonb','jsonb','numeric','text'],
    'auto_learn_geography helper installed'
);

SELECT finish();

ROLLBACK;
