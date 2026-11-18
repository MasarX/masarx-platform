-- Console V2 sender create duplicate guard.
--
-- Operators should not be able to create two active senders with the same
-- operator-facing name under one client. The UI maps this backend rejection to
-- friendly copy, and this RPC guard keeps stale UI/direct callers fail-closed.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605152155_console_v2_sender_create_duplicate_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_def TEXT;
  v_next TEXT;
BEGIN
  SELECT pg_get_functiondef('public.sender_create_v1(jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.sender_create_v1 function is missing';
  END IF;

  IF v_def LIKE '%sender_create_v1 duplicate active sender name%' THEN
    RAISE NOTICE 'sender_create_v1 already guards duplicate active sender names';
    RETURN;
  END IF;

  v_next := replace(
    v_def,
$old$
  v_client_org UUID;
$old$,
$new$
  v_client_org UUID;
  v_duplicate_sender_id UUID;
$new$
  );
  IF v_next = v_def THEN
    RAISE EXCEPTION 'sender_create_v1 duplicate declaration patch anchor not found';
  END IF;
  v_def := v_next;

  v_next := replace(
    v_def,
$old$
  INSERT INTO public.senders (
$old$,
$new$
  SELECT s.id
    INTO v_duplicate_sender_id
    FROM public.senders s
   WHERE s.client_id = v_client_id
     AND lower(btrim(s.name)) = lower(btrim(v_name))
     AND lower(COALESCE(s.status, 'active')) = 'active'
   LIMIT 1;

  IF v_duplicate_sender_id IS NOT NULL THEN
    RAISE EXCEPTION 'sender_create_v1 duplicate active sender name'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.senders (
$new$
  );
  IF v_next = v_def THEN
    RAISE EXCEPTION 'sender_create_v1 duplicate guard patch anchor not found';
  END IF;

  EXECUTE v_next;
END $do$;

REVOKE ALL ON FUNCTION public.sender_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sender_create_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sender_create_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.sender_create_v1(jsonb)
  IS 'Canonical write RPC: insert public.senders row (operator manual create) + decision_log + domain_event. Capability: senders.write. Rejects duplicate active sender names within a client.';

SELECT pg_advisory_unlock(hashtext('202605152155_console_v2_sender_create_duplicate_guard_v1'));

COMMIT;
