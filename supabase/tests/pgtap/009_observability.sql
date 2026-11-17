-- pgTAP: Unified observability view

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

SELECT has_view(
    'public',
    'observability_events_v',
    'observability_events_v view exists'
);

SELECT has_column(
    'public',
    'observability_events_v',
    'organization_id',
    'observability_events_v exposes organization_id'
);

SELECT has_column(
    'public',
    'observability_events_v',
    'event_source',
    'observability_events_v exposes event_source'
);

SELECT has_column(
    'public',
    'observability_events_v',
    'event_type',
    'observability_events_v exposes event_type'
);

SELECT has_column(
    'public',
    'observability_events_v',
    'event_time',
    'observability_events_v exposes event_time'
);

SELECT has_column(
    'public',
    'observability_events_v',
    'metadata',
    'observability_events_v exposes metadata payload'
);

SELECT finish();

ROLLBACK;
