BEGIN;

-- Phase 5 constraint hardening: enable shipment child / geocode foreign keys.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipment_boxes_shipment_fk') THEN
        EXECUTE 'ALTER TABLE public.shipment_boxes
                 ADD CONSTRAINT shipment_boxes_shipment_fk
                 FOREIGN KEY (shipment_id, client_id)
                 REFERENCES public.shipments (id, client_id)
                 DEFERRABLE INITIALLY DEFERRED';
    END IF;
END;
$$;

ALTER TABLE public.shipment_boxes
    VALIDATE CONSTRAINT shipment_boxes_shipment_fk;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'labels_shipment_fk') THEN
        EXECUTE 'ALTER TABLE public.labels
                 ADD CONSTRAINT labels_shipment_fk
                 FOREIGN KEY (shipment_id, client_id)
                 REFERENCES public.shipments (id, client_id)
                 DEFERRABLE INITIALLY DEFERRED';
    END IF;
END;
$$;

ALTER TABLE public.labels
    VALIDATE CONSTRAINT labels_shipment_fk;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipment_actions_shipment_fk') THEN
        EXECUTE '' ||
            'ALTER TABLE public.shipment_actions ' ||
            'ADD CONSTRAINT shipment_actions_shipment_fk ' ||
            'FOREIGN KEY (shipment_id, client_id) ' ||
            'REFERENCES public.shipments (id, client_id) ' ||
            'DEFERRABLE INITIALLY DEFERRED' ||
        '';
    END IF;
END;
$$;

ALTER TABLE public.shipment_actions
    VALIDATE CONSTRAINT shipment_actions_shipment_fk;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'geocodes_address_fk') THEN
        EXECUTE 'ALTER TABLE public.geocodes
                 ADD CONSTRAINT geocodes_address_fk
                 FOREIGN KEY (address_id, client_id)
                 REFERENCES public.addresses (id, client_id)
                 DEFERRABLE INITIALLY DEFERRED';
    END IF;
END;
$$;

ALTER TABLE public.geocodes
    VALIDATE CONSTRAINT geocodes_address_fk;

COMMIT;
