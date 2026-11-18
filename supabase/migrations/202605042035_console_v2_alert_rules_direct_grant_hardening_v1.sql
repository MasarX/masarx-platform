-- Console V2 reads alert configuration through registered projections/RPCs.
-- Do not grant browser roles direct table SELECT on alert_rules or
-- alert_triggers; the alert RLS pgTAP contract is intentionally stricter.

BEGIN;

REVOKE SELECT ON TABLE public.alert_rules FROM authenticated;
REVOKE SELECT ON TABLE public.alert_triggers FROM authenticated;

DROP POLICY IF EXISTS alert_rules_authenticated_select ON public.alert_rules;
DROP POLICY IF EXISTS alert_triggers_authenticated_select ON public.alert_triggers;

COMMIT;
