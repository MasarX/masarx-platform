-- Purpose: ensure the shipments.driver_user_id foreign key has a full supporting index.

CREATE INDEX IF NOT EXISTS idx_shipments_driver_user_id_fk
ON public.shipments (driver_user_id);
