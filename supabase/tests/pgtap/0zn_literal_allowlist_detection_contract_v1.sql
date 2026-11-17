BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
  public.constraint_has_literal_allowlist_v1(
    $$CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text])))$$
  ),
  'ARRAY literal allowlists are detected'
);

SELECT ok(
  public.constraint_has_literal_allowlist_v1(
    $$CHECK ((status IN ('pending', 'approved')))$$
  ),
  'IN list literal allowlists are detected'
);

SELECT ok(
  NOT public.constraint_has_literal_allowlist_v1(
    $$CHECK ((POSITION(('@'::text) IN (email)) > 1))$$
  ),
  'POSITION(... IN email) is not treated as a literal allowlist'
);

SELECT ok(
  NOT public.constraint_has_literal_allowlist_v1(
    $$CHECK ((email ~* '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'))$$
  ),
  'Regex validation is not treated as a literal allowlist'
);

SELECT finish();

ROLLBACK;
