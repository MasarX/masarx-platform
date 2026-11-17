-- Migration: Restrict authenticated read access to private label buckets

BEGIN;

DO $$
DECLARE
    v_owner text;
BEGIN
    SELECT pg_get_userbyid(relowner)
    INTO v_owner
    FROM pg_class
    WHERE oid = 'storage.objects'::regclass;

    IF v_owner = current_user THEN
        EXECUTE 'ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE storage.objects FORCE ROW LEVEL SECURITY';
        EXECUTE 'DROP POLICY IF EXISTS objects_authenticated_restrict_labels ON storage.objects';
        EXECUTE $ddl$
            CREATE POLICY objects_authenticated_restrict_labels
              ON storage.objects
              AS RESTRICTIVE
              FOR SELECT
              TO authenticated
              USING (
                bucket_id NOT IN ('labels','label-render-assets')
              )
        $ddl$;
    END IF;
END;
$$;

COMMIT;
