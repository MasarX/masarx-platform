-- pgTAP: Observability dashboard views exist

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

SELECT has_view('public', 'webhook_ack_metrics_5m_v', 'webhook_ack_metrics_5m_v view exists');
SELECT has_view('public', 'provider_health_latest_v', 'provider_health_latest_v view exists');
SELECT has_view('public', 'circuit_breaker_dashboard_v', 'circuit_breaker_dashboard_v view exists');

SELECT finish();

ROLLBACK;

