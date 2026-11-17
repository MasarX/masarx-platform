-- Test: audit_redaction_rules redacts configured columns in audit_table_changes
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

SELECT has_table('public', 'audit_redaction_rules', 'audit_redaction_rules table exists');
SELECT has_function('public', 'audit_redact_row', ARRAY['text','text','jsonb'], 'audit_redact_row function exists');

CREATE TABLE public.pgtap_audit_redaction (
  organization_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  secret_text TEXT,
  public_text TEXT,
  PRIMARY KEY (id)
);

CREATE TRIGGER audit_row_change
  BEFORE INSERT OR UPDATE OR DELETE ON public.pgtap_audit_redaction
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_capture_row_change();

INSERT INTO public.audit_redaction_rules (
  table_schema,
  table_name,
  mode,
  columns
)
VALUES (
  'public',
  'pgtap_audit_redaction',
  'denylist',
  ARRAY['secret_text']::text[]
);

INSERT INTO public.pgtap_audit_redaction (organization_id, secret_text, public_text)
VALUES ('11111111-1111-1111-1111-111111111111', 'supersecret', 'hello');

SELECT is(
  (
    SELECT row_new->>'secret_text'
    FROM public.audit_table_changes
    WHERE table_name = 'pgtap_audit_redaction'
      AND op = 'INSERT'
    ORDER BY created_at DESC
    LIMIT 1
  ),
  '[REDACTED]',
  'INSERT redacts denylisted column (secret_text)'
);

UPDATE public.pgtap_audit_redaction
SET secret_text = 'changed', public_text = 'world'
WHERE organization_id = '11111111-1111-1111-1111-111111111111';

SELECT is(
  (
    SELECT row_new->>'secret_text'
    FROM public.audit_table_changes
    WHERE table_name = 'pgtap_audit_redaction'
      AND op = 'UPDATE'
    ORDER BY created_at DESC
    LIMIT 1
  ),
  '[REDACTED]',
  'UPDATE redacts denylisted column (secret_text)'
);

DELETE FROM public.pgtap_audit_redaction
WHERE organization_id = '11111111-1111-1111-1111-111111111111';

SELECT is(
  (
    SELECT row_old->>'secret_text'
    FROM public.audit_table_changes
    WHERE table_name = 'pgtap_audit_redaction'
      AND op = 'DELETE'
    ORDER BY created_at DESC
    LIMIT 1
  ),
  '[REDACTED]',
  'DELETE redacts denylisted column (secret_text)'
);

SELECT finish();
ROLLBACK;

