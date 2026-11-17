-- Migration: RLS on labels and shipment_boxes
-- Purpose: Enforce tenant isolation using shipments join and service_role-only full access
-- Date: 2025-11-13

BEGIN;

-- labels
ALTER TABLE public.labels ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.labels FROM PUBLIC;
REVOKE ALL ON TABLE public.labels FROM anon;
REVOKE ALL ON TABLE public.labels FROM authenticated;

DROP POLICY IF EXISTS labels_service_policy ON public.labels;
CREATE POLICY labels_service_policy
  ON public.labels
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS labels_tenant_select ON public.labels;
CREATE POLICY labels_tenant_select
  ON public.labels
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM shipments s
      WHERE s.id = labels.shipment_id
        AND s.organization_id = current_user_org_id()
    )
  );

-- shipment_boxes
ALTER TABLE public.shipment_boxes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.shipment_boxes FROM PUBLIC;
REVOKE ALL ON TABLE public.shipment_boxes FROM anon;
REVOKE ALL ON TABLE public.shipment_boxes FROM authenticated;

DROP POLICY IF EXISTS shipment_boxes_service_policy ON public.shipment_boxes;
CREATE POLICY shipment_boxes_service_policy
  ON public.shipment_boxes
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS shipment_boxes_tenant_select ON public.shipment_boxes;
CREATE POLICY shipment_boxes_tenant_select
  ON public.shipment_boxes
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM shipments s
      WHERE s.id = shipment_boxes.shipment_id
        AND s.organization_id = current_user_org_id()
    )
  );

COMMIT;

