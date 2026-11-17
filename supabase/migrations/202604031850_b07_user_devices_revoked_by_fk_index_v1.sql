BEGIN;

SELECT pg_advisory_lock(hashtext('202604031850_b07_user_devices_revoked_by_fk_index_v1'));

CREATE INDEX IF NOT EXISTS idx_user_devices__revoked_by_user_id__fk
  ON public.user_devices (revoked_by_user_id);

SELECT pg_advisory_unlock(hashtext('202604031850_b07_user_devices_revoked_by_fk_index_v1'));

COMMIT;
