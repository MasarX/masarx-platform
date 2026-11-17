-- Test Suite: Internal view grants lockdown (deny anon/authenticated)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(44);

-- Each internal view must exist and be service-role only (no anon/authenticated).

SELECT has_view('public', 'observability_events_v', 'observability_events_v exists');
SELECT ok(NOT has_table_privilege('anon', 'public.observability_events_v', 'SELECT'), 'anon cannot SELECT observability_events_v');
SELECT ok(NOT has_table_privilege('authenticated', 'public.observability_events_v', 'SELECT'), 'authenticated cannot SELECT observability_events_v');
SELECT ok(has_table_privilege('service_role', 'public.observability_events_v', 'SELECT'), 'service_role can SELECT observability_events_v');

SELECT has_view('public', 'comms_reply_events_v', 'comms_reply_events_v exists');
SELECT ok(NOT has_table_privilege('anon', 'public.comms_reply_events_v', 'SELECT'), 'anon cannot SELECT comms_reply_events_v');
SELECT ok(NOT has_table_privilege('authenticated', 'public.comms_reply_events_v', 'SELECT'), 'authenticated cannot SELECT comms_reply_events_v');
SELECT ok(has_table_privilege('service_role', 'public.comms_reply_events_v', 'SELECT'), 'service_role can SELECT comms_reply_events_v');

SELECT has_view('public', 'comms_reply_failures_v', 'comms_reply_failures_v exists');
SELECT ok(NOT has_table_privilege('anon', 'public.comms_reply_failures_v', 'SELECT'), 'anon cannot SELECT comms_reply_failures_v');
SELECT ok(NOT has_table_privilege('authenticated', 'public.comms_reply_failures_v', 'SELECT'), 'authenticated cannot SELECT comms_reply_failures_v');
SELECT ok(has_table_privilege('service_role', 'public.comms_reply_failures_v', 'SELECT'), 'service_role can SELECT comms_reply_failures_v');

SELECT has_view('public', 'comms_reply_latency_v', 'comms_reply_latency_v exists');
SELECT ok(NOT has_table_privilege('anon', 'public.comms_reply_latency_v', 'SELECT'), 'anon cannot SELECT comms_reply_latency_v');
SELECT ok(NOT has_table_privilege('authenticated', 'public.comms_reply_latency_v', 'SELECT'), 'authenticated cannot SELECT comms_reply_latency_v');
SELECT ok(has_table_privilege('service_role', 'public.comms_reply_latency_v', 'SELECT'), 'service_role can SELECT comms_reply_latency_v');

SELECT has_view('public', 'label_job_barcode_summary_v', 'label_job_barcode_summary_v exists');
SELECT ok(NOT has_table_privilege('anon', 'public.label_job_barcode_summary_v', 'SELECT'), 'anon cannot SELECT label_job_barcode_summary_v');
SELECT ok(NOT has_table_privilege('authenticated', 'public.label_job_barcode_summary_v', 'SELECT'), 'authenticated cannot SELECT label_job_barcode_summary_v');
SELECT ok(has_table_privilege('service_role', 'public.label_job_barcode_summary_v', 'SELECT'), 'service_role can SELECT label_job_barcode_summary_v');

SELECT has_view('public', 'label_job_barcode_blocks_v', 'label_job_barcode_blocks_v exists');
SELECT ok(NOT has_table_privilege('anon', 'public.label_job_barcode_blocks_v', 'SELECT'), 'anon cannot SELECT label_job_barcode_blocks_v');
SELECT ok(NOT has_table_privilege('authenticated', 'public.label_job_barcode_blocks_v', 'SELECT'), 'authenticated cannot SELECT label_job_barcode_blocks_v');
SELECT ok(has_table_privilege('service_role', 'public.label_job_barcode_blocks_v', 'SELECT'), 'service_role can SELECT label_job_barcode_blocks_v');

SELECT has_view('public', 'v_benchmark_latest_run', 'v_benchmark_latest_run exists');
SELECT ok(NOT has_table_privilege('anon', 'public.v_benchmark_latest_run', 'SELECT'), 'anon cannot SELECT v_benchmark_latest_run');
SELECT ok(NOT has_table_privilege('authenticated', 'public.v_benchmark_latest_run', 'SELECT'), 'authenticated cannot SELECT v_benchmark_latest_run');
SELECT ok(has_table_privilege('service_role', 'public.v_benchmark_latest_run', 'SELECT'), 'service_role can SELECT v_benchmark_latest_run');

SELECT has_view('public', 'v_benchmark_failures', 'v_benchmark_failures exists');
SELECT ok(NOT has_table_privilege('anon', 'public.v_benchmark_failures', 'SELECT'), 'anon cannot SELECT v_benchmark_failures');
SELECT ok(NOT has_table_privilege('authenticated', 'public.v_benchmark_failures', 'SELECT'), 'authenticated cannot SELECT v_benchmark_failures');
SELECT ok(has_table_privilege('service_role', 'public.v_benchmark_failures', 'SELECT'), 'service_role can SELECT v_benchmark_failures');

SELECT has_view('public', 'v_benchmark_failures_latest_run', 'v_benchmark_failures_latest_run exists');
SELECT ok(NOT has_table_privilege('anon', 'public.v_benchmark_failures_latest_run', 'SELECT'), 'anon cannot SELECT v_benchmark_failures_latest_run');
SELECT ok(NOT has_table_privilege('authenticated', 'public.v_benchmark_failures_latest_run', 'SELECT'), 'authenticated cannot SELECT v_benchmark_failures_latest_run');
SELECT ok(has_table_privilege('service_role', 'public.v_benchmark_failures_latest_run', 'SELECT'), 'service_role can SELECT v_benchmark_failures_latest_run');

SELECT has_view('public', 'v_benchmark_plugin_metrics', 'v_benchmark_plugin_metrics exists');
SELECT ok(NOT has_table_privilege('anon', 'public.v_benchmark_plugin_metrics', 'SELECT'), 'anon cannot SELECT v_benchmark_plugin_metrics');
SELECT ok(NOT has_table_privilege('authenticated', 'public.v_benchmark_plugin_metrics', 'SELECT'), 'authenticated cannot SELECT v_benchmark_plugin_metrics');
SELECT ok(has_table_privilege('service_role', 'public.v_benchmark_plugin_metrics', 'SELECT'), 'service_role can SELECT v_benchmark_plugin_metrics');

SELECT has_view('public', 'v_benchmark_plugin_metrics_latest_run', 'v_benchmark_plugin_metrics_latest_run exists');
SELECT ok(NOT has_table_privilege('anon', 'public.v_benchmark_plugin_metrics_latest_run', 'SELECT'), 'anon cannot SELECT v_benchmark_plugin_metrics_latest_run');
SELECT ok(NOT has_table_privilege('authenticated', 'public.v_benchmark_plugin_metrics_latest_run', 'SELECT'), 'authenticated cannot SELECT v_benchmark_plugin_metrics_latest_run');
SELECT ok(has_table_privilege('service_role', 'public.v_benchmark_plugin_metrics_latest_run', 'SELECT'), 'service_role can SELECT v_benchmark_plugin_metrics_latest_run');

SELECT finish();

ROLLBACK;

