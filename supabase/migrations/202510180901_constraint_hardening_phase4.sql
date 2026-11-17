BEGIN;

-- Normalize legacy sentinel usage so global scope rows store NULL consistently.
ALTER TABLE public.settings
    ALTER COLUMN scope_id DROP NOT NULL;

ALTER TABLE public.settings_cache
    ALTER COLUMN settings_scope_id DROP NOT NULL;

UPDATE public.settings
SET scope_id = NULL
WHERE scope_type = 'global'
  AND scope_id = '00000000-0000-0000-0000-000000000000'::uuid;

UPDATE public.settings_cache
SET settings_scope_id = NULL
WHERE settings_scope_id = '00000000-0000-0000-0000-000000000000'::uuid;

CREATE OR REPLACE FUNCTION public.validate_settings_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    scope_valid boolean := false;
    sentinel_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
BEGIN
    IF NEW.scope_type = 'global' THEN
        IF NEW.scope_id IS NULL THEN
            scope_valid := true;
        ELSIF TG_TABLE_NAME = 'settings_versions' AND NEW.scope_id = sentinel_uuid THEN
            -- Temporary allowance until settings_versions is rebuilt in migration 202510180903.
            scope_valid := true;
        END IF;
    ELSIF NEW.scope_type = 'tenant' THEN
        SELECT TRUE INTO scope_valid FROM public.organizations WHERE id = NEW.scope_id;
    ELSIF NEW.scope_type = 'client' THEN
        SELECT TRUE INTO scope_valid FROM public.clients WHERE id = NEW.scope_id;
    ELSIF NEW.scope_type = 'sender' THEN
        SELECT TRUE INTO scope_valid FROM public.senders WHERE id = NEW.scope_id;
    ELSIF NEW.scope_type = 'resource' THEN
        SELECT TRUE INTO scope_valid FROM public.providers WHERE id = NEW.scope_id;
    ELSIF NEW.scope_type = 'source' THEN
        SELECT TRUE INTO scope_valid FROM public.webhook_sources WHERE id = NEW.scope_id;
    ELSE
        RAISE EXCEPTION 'Unsupported scope_type %', NEW.scope_type USING ERRCODE = '23514';
    END IF;

    IF NOT scope_valid THEN
        RAISE EXCEPTION 'Invalid scope %/% for % record %', NEW.scope_type, NEW.scope_id, TG_TABLE_NAME, NEW.id USING ERRCODE = '23514';
    END IF;

    IF TG_TABLE_NAME = 'settings' THEN
        PERFORM 1
        FROM public.settings_versions sv
        WHERE sv.id = NEW.settings_version_id
          AND sv.scope_type = NEW.scope_type
          AND sv.scope_id IS NOT DISTINCT FROM NEW.scope_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'settings row % references version % with mismatched scope', NEW.id, NEW.settings_version_id USING ERRCODE = '23503';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS settings_versions_scope_guard ON public.settings_versions;
CREATE CONSTRAINT TRIGGER settings_versions_scope_guard
AFTER INSERT OR UPDATE ON public.settings_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validate_settings_scope();

DROP TRIGGER IF EXISTS settings_scope_guard ON public.settings;
CREATE CONSTRAINT TRIGGER settings_scope_guard
AFTER INSERT OR UPDATE ON public.settings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validate_settings_scope();

ALTER TABLE public.settings
    DROP CONSTRAINT IF EXISTS settings_settings_version_fk;
ALTER TABLE public.settings
    ADD CONSTRAINT settings_settings_version_fk
    FOREIGN KEY (settings_version_id, scope_id)
    REFERENCES public.settings_versions (id, scope_id)
    DEFERRABLE INITIALLY DEFERRED
    NOT VALID;

ALTER TABLE public.recipient_preferences
    DROP CONSTRAINT IF EXISTS recipient_preferences_recipient_fk;
ALTER TABLE public.recipient_preferences
    ADD CONSTRAINT recipient_preferences_recipient_fk
    FOREIGN KEY (recipient_id)
    REFERENCES public.recipients (id)
    DEFERRABLE INITIALLY DEFERRED
    NOT VALID;

ALTER TABLE public.comms_attempts
    DROP CONSTRAINT IF EXISTS comms_attempts_outbound_call_fk;
ALTER TABLE public.comms_attempts
    ADD CONSTRAINT comms_attempts_outbound_call_fk
    FOREIGN KEY (outbound_call_id)
    REFERENCES public.outbound_calls (id)
    DEFERRABLE INITIALLY DEFERRED
    NOT VALID;

ALTER TABLE public.settings
    ADD CONSTRAINT settings_scope_id_no_sentinel
    CHECK (scope_id IS NULL OR scope_id <> '00000000-0000-0000-0000-000000000000'::uuid);

ALTER TABLE public.settings_cache
    ADD CONSTRAINT settings_cache_scope_id_no_sentinel
    CHECK (settings_scope_id IS NULL OR settings_scope_id <> '00000000-0000-0000-0000-000000000000'::uuid);

ALTER TABLE public.settings
    VALIDATE CONSTRAINT settings_settings_version_fk;
ALTER TABLE public.recipient_preferences
    VALIDATE CONSTRAINT recipient_preferences_recipient_fk;
ALTER TABLE public.comms_attempts
    VALIDATE CONSTRAINT comms_attempts_outbound_call_fk;
ALTER TABLE public.settings
    VALIDATE CONSTRAINT settings_scope_id_no_sentinel;
ALTER TABLE public.settings_cache
    VALIDATE CONSTRAINT settings_cache_scope_id_no_sentinel;

COMMIT;
