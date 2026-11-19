BEGIN;

CREATE INDEX IF NOT EXISTS idx_vehicle_documents_artifact_id_fk
  ON public.vehicle_documents (artifact_id);

CREATE INDEX IF NOT EXISTS idx_vehicle_documents_vehicle_id
  ON public.vehicle_documents (vehicle_id);

CREATE INDEX IF NOT EXISTS idx_vehicle_documents_verified_by_user_id
  ON public.vehicle_documents (verified_by_user_id);

COMMIT;
