BEGIN;

ALTER TABLE public.shipment_boxes
    ADD COLUMN organization_id UUID,
    ADD COLUMN client_id UUID;

ALTER TABLE public.labels
    ADD COLUMN organization_id UUID,
    ADD COLUMN client_id UUID;

ALTER TABLE public.shipment_actions
    ADD COLUMN organization_id UUID,
    ADD COLUMN client_id UUID;

ALTER TABLE public.geocodes
    ADD COLUMN organization_id UUID,
    ADD COLUMN client_id UUID;

WITH updated_boxes AS (
    UPDATE public.shipment_boxes sb
    SET organization_id = s.organization_id,
        client_id = s.client_id
    FROM public.shipments s
    WHERE sb.shipment_id = s.id
      AND (sb.organization_id IS DISTINCT FROM s.organization_id OR sb.client_id IS DISTINCT FROM s.client_id)
    RETURNING 1
),
updated_labels AS (
    UPDATE public.labels l
    SET organization_id = s.organization_id,
        client_id = s.client_id
    FROM public.shipments s
    WHERE l.shipment_id = s.id
      AND (l.organization_id IS DISTINCT FROM s.organization_id OR l.client_id IS DISTINCT FROM s.client_id)
    RETURNING 1
),
updated_actions AS (
    UPDATE public.shipment_actions sa
    SET organization_id = s.organization_id,
        client_id = s.client_id
    FROM public.shipments s
    WHERE sa.shipment_id = s.id
      AND (sa.organization_id IS DISTINCT FROM s.organization_id OR sa.client_id IS DISTINCT FROM s.client_id)
    RETURNING 1
),
updated_geocodes AS (
    UPDATE public.geocodes g
    SET organization_id = a.organization_id,
        client_id = a.client_id
    FROM public.addresses a
    WHERE g.address_id = a.id
      AND (g.organization_id IS DISTINCT FROM a.organization_id OR g.client_id IS DISTINCT FROM a.client_id)
    RETURNING 1
)
SELECT
    (SELECT COUNT(*) FROM updated_boxes)  AS boxes_backfilled,
    (SELECT COUNT(*) FROM updated_labels) AS labels_backfilled,
    (SELECT COUNT(*) FROM updated_actions) AS actions_backfilled,
    (SELECT COUNT(*) FROM updated_geocodes) AS geocodes_backfilled;

ALTER TABLE public.shipment_boxes
    ALTER COLUMN organization_id SET NOT NULL,
    ALTER COLUMN client_id SET NOT NULL;

ALTER TABLE public.labels
    ALTER COLUMN organization_id SET NOT NULL,
    ALTER COLUMN client_id SET NOT NULL;

ALTER TABLE public.shipment_actions
    ALTER COLUMN organization_id SET NOT NULL,
    ALTER COLUMN client_id SET NOT NULL;

ALTER TABLE public.geocodes
    ALTER COLUMN organization_id SET NOT NULL,
    ALTER COLUMN client_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shipment_boxes_org_client ON public.shipment_boxes (organization_id, client_id);
CREATE INDEX IF NOT EXISTS idx_labels_org_client ON public.labels (organization_id, client_id);
CREATE INDEX IF NOT EXISTS idx_shipment_actions_org_client ON public.shipment_actions (organization_id, client_id);
CREATE INDEX IF NOT EXISTS idx_geocodes_org_client ON public.geocodes (organization_id, client_id);

COMMIT;
