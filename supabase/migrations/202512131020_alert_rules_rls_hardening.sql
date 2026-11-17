-- Migration: Harden RLS + grants for alert_rules and alert_triggers
-- Purpose: Principle-of-least-privilege: explicit service_role policies and no anon/authenticated grants.
-- Date: 2025-12-13 10:20 UTC

BEGIN;

ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_triggers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.alert_rules FROM PUBLIC;
REVOKE ALL ON TABLE public.alert_rules FROM anon;
REVOKE ALL ON TABLE public.alert_rules FROM authenticated;

REVOKE ALL ON TABLE public.alert_triggers FROM PUBLIC;
REVOKE ALL ON TABLE public.alert_triggers FROM anon;
REVOKE ALL ON TABLE public.alert_triggers FROM authenticated;

GRANT ALL ON TABLE public.alert_rules TO service_role;
GRANT ALL ON TABLE public.alert_triggers TO service_role;

DROP POLICY IF EXISTS alert_rules_service_policy ON public.alert_rules;
CREATE POLICY alert_rules_service_policy
  ON public.alert_rules
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS alert_triggers_service_policy ON public.alert_triggers;
CREATE POLICY alert_triggers_service_policy
  ON public.alert_triggers
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

COMMIT;

