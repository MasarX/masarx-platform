-- Console V2 basket writes are command-only.
--
-- Baskets are readable through api.baskets, but browser clients must create
-- baskets through basket_create_v1 and transition state through
-- ui_update_basket_state_v1. Basket membership remains workflow/policy-owned.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605050030_console_v2_basket_rpc_only_write_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;

REVOKE INSERT, UPDATE, DELETE ON TABLE api.baskets FROM PUBLIC, anon, authenticated;

COMMENT ON VIEW api.baskets
  IS 'Console V2 read projection for baskets. Browser writes are RPC-only: use api.basket_create_v1 and api.ui_update_basket_state_v1; basket item membership is workflow/policy-owned.';

SELECT pg_advisory_unlock(hashtext('202605050030_console_v2_basket_rpc_only_write_contract_v1'));

COMMIT;
