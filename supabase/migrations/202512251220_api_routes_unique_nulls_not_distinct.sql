-- Plan: PLAN-202512-api-gateway-logestechs-v2-mirror / Step: S04
-- Migration: Enforce unique api_routes including global scope
-- Purpose: Prevent duplicate (method,path,scope) rows when scope_id is NULL (global scope) by using NULLS NOT DISTINCT.
-- Date: 2025-12-25

BEGIN;

SET search_path TO public, extensions, pg_temp;

ALTER TABLE public.api_routes
  DROP CONSTRAINT IF EXISTS api_routes_method_path_template_scope_type_scope_id_key;

ALTER TABLE public.api_routes
  ADD CONSTRAINT api_routes_method_path_template_scope_type_scope_id_key
  UNIQUE NULLS NOT DISTINCT (method, path_template, scope_type, scope_id);

COMMIT;

