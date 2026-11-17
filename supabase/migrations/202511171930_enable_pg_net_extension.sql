-- Migration: Enable pg_net extension for HTTP execution
-- Date: 2025-11-17
-- Purpose:
--   Ensure the pg_net extension is available so that call_api()
--   and related helpers using net.http_* functions lint and run
--   correctly in cloud environments.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_net;

COMMIT;

