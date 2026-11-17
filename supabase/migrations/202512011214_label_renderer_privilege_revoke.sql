-- Migration: Label renderer invoke privilege hardening
-- Purpose: Remove authenticated/public execution on invoke_label_renderer(int)
--          and scope execution to service_role + edge_label_renderer_role.

BEGIN;

REVOKE EXECUTE ON FUNCTION invoke_label_renderer(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION invoke_label_renderer(INT) FROM authenticated;

GRANT EXECUTE ON FUNCTION invoke_label_renderer(INT) TO service_role;
GRANT EXECUTE ON FUNCTION invoke_label_renderer(INT) TO edge_label_renderer_role;

COMMIT;
