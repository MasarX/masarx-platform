-- Migration: Release leaked advisory lock from tasks.complete additive merge repair
-- Purpose:
-- - Keep migration history append-only now that
--   `202604101376_ui_command_registry_tasks_complete_additive_merge_fix_v1` is already on `dev`.
-- - Release the leaked session lock when new databases replay the migration chain on a
--   single connection.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604102320_tasks_complete_additive_merge_unlock_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- The shipped 202604101376 migration acquires this lock but unlocks the previous 202604101375
-- key. Releasing it here repairs forward replays without rewriting base history.
SELECT pg_advisory_unlock(hashtext('202604101376_ui_command_registry_tasks_complete_additive_merge_fix_v1'));

SELECT pg_advisory_unlock(hashtext('202604102320_tasks_complete_additive_merge_unlock_repair_v1'));
COMMIT;
