-- Migration: Partition-safe FK hardening (core domain integrity)
-- Purpose:
--   - Prevent cross-tenant/cross-client references at the database layer.
--   - Add partition-safe composite foreign keys for partitioned tables.
BEGIN;

SELECT pg_advisory_lock(hashtext('202512291340_partition_safe_fk_hardening'));
SET search_path TO public, pg_temp;

-- 1) Support composite FKs with redundant-but-safe unique constraints.
ALTER TABLE public.clients
  DROP CONSTRAINT IF EXISTS clients_id_organization_unique;
ALTER TABLE public.clients
  ADD CONSTRAINT clients_id_organization_unique UNIQUE (id, organization_id);

ALTER TABLE public.senders
  DROP CONSTRAINT IF EXISTS senders_id_client_unique;
ALTER TABLE public.senders
  ADD CONSTRAINT senders_id_client_unique UNIQUE (id, client_id);

ALTER TABLE public.recipients
  DROP CONSTRAINT IF EXISTS recipients_id_client_unique;
ALTER TABLE public.recipients
  ADD CONSTRAINT recipients_id_client_unique UNIQUE (id, client_id);

-- 2) Enforce (client_id, organization_id) consistency across domain tables.
ALTER TABLE public.addresses
  DROP CONSTRAINT IF EXISTS addresses_client_org_fk;
ALTER TABLE public.addresses
  ADD CONSTRAINT addresses_client_org_fk
  FOREIGN KEY (client_id, organization_id)
  REFERENCES public.clients (id, organization_id)
  DEFERRABLE INITIALLY DEFERRED
  ;

ALTER TABLE public.recipients
  DROP CONSTRAINT IF EXISTS recipients_client_org_fk;
ALTER TABLE public.recipients
  ADD CONSTRAINT recipients_client_org_fk
  FOREIGN KEY (client_id, organization_id)
  REFERENCES public.clients (id, organization_id)
  DEFERRABLE INITIALLY DEFERRED
  ;

ALTER TABLE public.shipments
  DROP CONSTRAINT IF EXISTS shipments_client_org_fk;
ALTER TABLE public.shipments
  ADD CONSTRAINT shipments_client_org_fk
  FOREIGN KEY (client_id, organization_id)
  REFERENCES public.clients (id, organization_id)
  DEFERRABLE INITIALLY DEFERRED
  ;

-- 3) Warehouse address integrity (addresses PK is (id, client_id)).
ALTER TABLE public.clients
  DROP CONSTRAINT IF EXISTS clients_warehouse_address_fk;
ALTER TABLE public.clients
  ADD CONSTRAINT clients_warehouse_address_fk
  FOREIGN KEY (warehouse_address_id, id)
  REFERENCES public.addresses (id, client_id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED
  ;

ALTER TABLE public.senders
  DROP CONSTRAINT IF EXISTS senders_warehouse_address_fk;
ALTER TABLE public.senders
  ADD CONSTRAINT senders_warehouse_address_fk
  FOREIGN KEY (warehouse_address_id, client_id)
  REFERENCES public.addresses (id, client_id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED
  ;

-- 4) Shipments: partition-safe FKs to sender/recipient/addresses.
-- Drop legacy sender FK (id-only) and replace with composite to enforce same client.
ALTER TABLE public.shipments
  DROP CONSTRAINT IF EXISTS shipments_sender_id_fkey;
ALTER TABLE public.shipments
  DROP CONSTRAINT IF EXISTS shipments_sender_fk;
ALTER TABLE public.shipments
  ADD CONSTRAINT shipments_sender_fk
  FOREIGN KEY (sender_id, client_id)
  REFERENCES public.senders (id, client_id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED
  ;

ALTER TABLE public.shipments
  DROP CONSTRAINT IF EXISTS shipments_origin_address_fk;
ALTER TABLE public.shipments
  ADD CONSTRAINT shipments_origin_address_fk
  FOREIGN KEY (origin_address_id, client_id)
  REFERENCES public.addresses (id, client_id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED
  ;

ALTER TABLE public.shipments
  DROP CONSTRAINT IF EXISTS shipments_destination_address_fk;
ALTER TABLE public.shipments
  ADD CONSTRAINT shipments_destination_address_fk
  FOREIGN KEY (destination_address_id, client_id)
  REFERENCES public.addresses (id, client_id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED
  ;

ALTER TABLE public.shipments
  DROP CONSTRAINT IF EXISTS shipments_recipient_fk;
ALTER TABLE public.shipments
  ADD CONSTRAINT shipments_recipient_fk
  FOREIGN KEY (recipient_id, client_id)
  REFERENCES public.recipients (id, client_id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED
  ;

-- 5) Performance indexes for sender-scope access patterns (RLS joins).
CREATE INDEX IF NOT EXISTS idx_shipments_sender_id
  ON public.shipments (sender_id)
  WHERE sender_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shipments_sender_recipient
  ON public.shipments (sender_id, recipient_id)
  WHERE sender_id IS NOT NULL AND recipient_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shipments_sender_origin_address
  ON public.shipments (sender_id, origin_address_id)
  WHERE sender_id IS NOT NULL AND origin_address_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shipments_sender_destination_address
  ON public.shipments (sender_id, destination_address_id)
  WHERE sender_id IS NOT NULL AND destination_address_id IS NOT NULL;

SELECT pg_advisory_unlock(hashtext('202512291340_partition_safe_fk_hardening'));

COMMIT;
