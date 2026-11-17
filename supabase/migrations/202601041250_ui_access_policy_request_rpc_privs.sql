BEGIN;

REVOKE ALL ON FUNCTION public.ui_request_access_policy_change_v1(jsonb, text, uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_request_access_policy_change_v1(jsonb, text, uuid, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ui_request_access_policy_change_v1(jsonb, text, uuid, text, timestamptz) TO service_role;

COMMIT;
