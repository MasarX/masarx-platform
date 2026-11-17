-- Migration: Remove legacy post-ack workflow artifacts
-- Date: 2025-11-22 10:45 UTC

BEGIN;

-- Drop unused dispatcher entrypoints lingering in cloud schema.
DROP FUNCTION IF EXISTS public.execute_post_ack_actions(UUID, JSONB, JSONB);
DROP FUNCTION IF EXISTS public.start_post_ack_actions_workflow(UUID, JSONB, JSONB);

-- Drop handler implementations that depended on the post-ack workflow.
DROP FUNCTION IF EXISTS workflow_handlers.execute_post_ack_geocode_v1(public.workflow_run_steps, public.workflow_runs, JSONB);
DROP FUNCTION IF EXISTS workflow_handlers.execute_post_ack_notification_v1(public.workflow_run_steps, public.workflow_runs, JSONB);

COMMIT;
