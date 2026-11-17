-- Recovered from supabase_migrations.schema_migrations on 2025-10-21T09:46:33Z
-- Version: 202510200001
-- Name: label_generation_core

-- Migration 202510200001: Label Generation Core Infrastructure
-- Purpose: Introduce configuration contracts, template catalog, job queue, and supporting functions for label/waybill rendering.
-- Alignment: SIMPLE · SCALABLE · DYNAMIC · ZERO-REDUNDANCY · ZERO HARD-CODING · PERMANENT · Global -> Tenant -> Client -> Sender -> Resource ladder.

SET search_path = public;

-- =============================================================================
-- SECTION 1: Schema registry entries for label generation contracts
-- =============================================================================

WITH label_design_payload AS (
    SELECT
        'bbbb0000-0000-0000-0000-000000000901'::uuid AS id,
        'label_design'::text AS category,
        1 AS version,
        $${
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "Label Design Configuration",
            "type": "object",
            "required": ["version", "templates"],
            "additionalProperties": false,
            "properties": {
                "version": {"type": "integer", "minimum": 1},
                "generate_after_geocode": {"type": "boolean"},
                "templates": {
                    "type": "object",
                    "minProperties": 1,
                    "additionalProperties": {
                        "type": "object",
                        "required": ["template_key"],
                        "additionalProperties": true,
                        "properties": {
                            "template_key": {"type": "string", "minLength": 1},
                            "template_version": {"type": "integer", "minimum": 1},
                            "provider_hint": {"type": "string"},
                            "max_attempts": {"type": "integer", "minimum": 1},
                            "retry_backoff_seconds": {
                                "type": "array",
                                "items": {"type": "integer", "minimum": 0}
                            },
                            "barcode_format": {"type": "string"},
                            "output_filename_pattern": {"type": "string"},
                            "metadata": {"type": "object"},
                            "asset_policy": {"type": "object"}
                        }
                    }
                }
            }
        }$$::jsonb AS schema_doc,
        'Label design configuration contract describing template usage, retry/backoff, and sequencing.'::text AS description,
        $$[
            {
                "version": 1,
                "generate_after_geocode": true,
                "templates": {
                    "shipping": {
                        "template_key": "standard_4x6",
                        "template_version": 1,
                        "provider_hint": "internal",
                        "max_attempts": 5,
                        "retry_backoff_seconds": [30, 120, 300],
                        "barcode_format": "CODE128"
                    }
                }
            }
        ]$$::jsonb AS examples
)
INSERT INTO schema_registry (
    id,
    category,
    version,
    schema,
    description,
    examples,
    is_active,
    created_at
)
SELECT
    id,
    category,
    version,
    schema_doc,
    description,
    examples,
    TRUE,
    workflow_now()
FROM label_design_payload
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE,
    created_at = workflow_now();

WITH label_provider_payload AS (
    SELECT
        'bbbb0000-0000-0000-0000-000000000902'::uuid AS id,
        'label_provider'::text AS category,
        1 AS version,
        $${
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "Label Provider Configuration",
            "type": "object",
            "required": ["version"],
            "additionalProperties": true,
            "properties": {
                "version": {"type": "integer", "minimum": 1},
                "providers": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["name"],
                        "additionalProperties": true,
                        "properties": {
                            "name": {"type": "string"},
                            "mode": {"type": "string", "enum": ["internal", "external"]},
                            "endpoint": {"type": "string"},
                            "headers": {"type": "object"},
                            "timeout_ms": {"type": "integer", "minimum": 1000},
                            "retry_policy": {
                                "type": "object",
                                "properties": {
                                    "max_attempts": {"type": "integer", "minimum": 1},
                                    "backoff_seconds": {
                                        "type": "array",
                                        "items": {"type": "integer", "minimum": 0}
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }$$::jsonb AS schema_doc,
        'Label provider configuration contract covering internal/external renderer hints.'::text AS description,
        $$[
            {
                "version": 1,
                "providers": [
                    {
                        "name": "internal_renderer",
                        "mode": "internal",
                        "timeout_ms": 15000
                    }
                ]
            }
        ]$$::jsonb AS examples
)
INSERT INTO schema_registry (
    id,
    category,
    version,
    schema,
    description,
    examples,
    is_active,
    created_at
)
SELECT
    id,
    category,
    version,
    schema_doc,
    description,
    examples,
    TRUE,
    workflow_now()
FROM label_provider_payload
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE,
    created_at = workflow_now();

WITH label_assets_payload AS (
    SELECT
        'bbbb0000-0000-0000-0000-000000000903'::uuid AS id,
        'label_render_assets'::text AS category,
        1 AS version,
        $${
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "Label Render Assets",
            "type": "object",
            "required": ["version", "assets"],
            "additionalProperties": false,
            "properties": {
                "version": {"type": "integer", "minimum": 1},
                "assets": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["name", "storage_key"],
                        "additionalProperties": false,
                        "properties": {
                            "name": {"type": "string"},
                            "storage_key": {"type": "string"},
                            "content_type": {"type": "string"},
                            "checksum": {"type": "string"},
                            "last_modified": {"type": "string", "format": "date-time"}
                        }
                    }
                }
            }
        }$$::jsonb AS schema_doc,
        'Renderer asset manifest describing storage objects (fonts, logos, brand assets).'::text AS description,
        $$[
            {
                "version": 1,
                "assets": [
                    {
                        "name": "primary_logo",
                        "storage_key": "labels/assets/default-logo.png",
                        "content_type": "image/png",
                        "checksum": "sha256:example"
                    }
                ]
            }
        ]$$::jsonb AS examples
)
INSERT INTO schema_registry (
    id,
    category,
    version,
    schema,
    description,
    examples,
    is_active,
    created_at
)
SELECT
    id,
    category,
    version,
    schema_doc,
    description,
    examples,
    TRUE,
    workflow_now()
FROM label_assets_payload
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE,
    created_at = workflow_now();

-- =============================================================================
-- SECTION 2: Seed global defaults for label design and provider policies
-- =============================================================================

WITH default_label_design AS (
    SELECT
        '77770000-0000-0000-0000-000000000101'::uuid AS settings_version_id,
        jsonb_build_object(
            'version', 1,
            'generate_after_geocode', true,
            'templates', jsonb_build_object(
                'shipping', jsonb_build_object(
                    'template_key', 'standard_4x6',
                    'provider_hint', 'internal_renderer',
                    'max_attempts', 5,
                    'retry_backoff_seconds', jsonb_build_array(30, 120, 300),
                    'barcode_format', 'CODE128',
                    'output_filename_pattern', 'labels/{tracking_number}-{box_number}.pdf'
                )
            )
        ) AS payload
),
upsert_label_design AS (
    INSERT INTO settings_versions (
        id,
        category,
        scope_type,
        scope_id,
        scope_hash,
        version,
        value,
        schema_version,
        change_reason,
        approved_at,
        effective_from
    )
    SELECT
        settings_version_id,
        'label_design',
        'global',
        NULL,
        '00000000-0000-0000-0000-000000000000'::uuid,
        1,
        payload,
        1,
        'Initial global label design baseline',
        workflow_now(),
        workflow_now()
    FROM default_label_design
    ON CONFLICT (id, scope_hash) DO UPDATE
    SET value = EXCLUDED.value,
        change_reason = EXCLUDED.change_reason,
        approved_at = EXCLUDED.approved_at,
        effective_from = EXCLUDED.effective_from
    RETURNING id, value
)
INSERT INTO settings (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
)
SELECT
    '66660000-0000-0000-0000-000000000101',
    'label_design',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    id,
    value,
    workflow_now()
FROM upsert_label_design
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

-- =============================================================================
-- SECTION 3: Label template catalog (label_template_specs)
-- =============================================================================

CREATE TABLE label_template_specs (
    id UUID DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    template_key TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    template_scope_type TEXT NOT NULL,
    template_scope_id UUID,
    renderer_config JSONB NOT NULL,
    asset_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, organization_id),
    CONSTRAINT label_template_specs_scope_type_chk CHECK (
        template_scope_type IN ('global', 'tenant', 'client', 'sender', 'resource')
    ),
    CONSTRAINT label_template_specs_scope_chk CHECK (
        (template_scope_type = 'global' AND template_scope_id IS NULL)
        OR (template_scope_type <> 'global' AND template_scope_id IS NOT NULL)
    ),
    CONSTRAINT label_template_specs_renderer_config_obj CHECK (jsonb_typeof(renderer_config) = 'object'),
CONSTRAINT label_template_specs_asset_refs_array CHECK (jsonb_typeof(asset_refs) = 'array')
) PARTITION BY HASH (organization_id);

CREATE TABLE label_template_specs_p0
    PARTITION OF label_template_specs
    FOR VALUES WITH (MODULUS 1, REMAINDER 0);

CREATE UNIQUE INDEX uq_label_template_specs_key_version
    ON label_template_specs (organization_id, template_key, version);

CREATE INDEX idx_label_template_specs_p0_key_version
    ON label_template_specs_p0 (organization_id, template_key, version DESC);

CREATE INDEX idx_label_template_specs_p0_scope
    ON label_template_specs_p0 (template_scope_type, template_scope_id);

COMMENT ON TABLE label_template_specs IS 'Renderer template catalog storing immutable layout instructions per organization.';

COMMENT ON COLUMN label_template_specs.template_scope_type IS 'Scope used when resolving template (global, tenant, client, sender, resource).';

COMMENT ON COLUMN label_template_specs.renderer_config IS 'JSON instructions describing layout zones, fonts, barcodes, and rendering logic.';

COMMENT ON COLUMN label_template_specs.asset_refs IS 'Array of renderer assets (storage keys, metadata) referenced by this template.';

CREATE OR REPLACE FUNCTION label_template_specs_prevent_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Label template specs are immutable; insert a new version instead.';
END;
$$;

CREATE TRIGGER trg_label_template_specs_prevent_update
    BEFORE UPDATE ON label_template_specs
    FOR EACH ROW
    EXECUTE FUNCTION label_template_specs_prevent_update();

ALTER TABLE label_template_specs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE label_template_specs FROM anon;

REVOKE ALL ON TABLE label_template_specs FROM authenticated;

CREATE POLICY label_template_specs_select_authenticated
    ON label_template_specs
    FOR SELECT
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY label_template_specs_service_all
    ON label_template_specs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

INSERT INTO label_template_specs (
    organization_id,
    template_key,
    version,
    template_scope_type,
    template_scope_id,
    renderer_config,
    asset_refs,
    created_by
)
SELECT
    o.id,
    'standard_4x6',
    1,
    'tenant',
    o.id,
    jsonb_build_object(
        'page', jsonb_build_object(
            'width_mm', 100,
            'height_mm', 150,
            'dpi', 203,
            'orientation', 'portrait'
        ),
        'barcode', jsonb_build_object(
            'type', 'CODE128',
            'value_path', 'box.barcode',
            'human_readable', 'shipment.tracking_number'
        ),
        'zones', jsonb_build_array(
            jsonb_build_object(
                'type', 'text',
                'binding', 'shipment.tracking_number',
                'x', 12,
                'y', 14,
                'font', 'open_sans_bold',
                'size', 18
            ),
            jsonb_build_object(
                'type', 'text',
                'binding', 'recipient.name',
                'x', 12,
                'y', 40,
                'font', 'open_sans_regular',
                'size', 14
            ),
            jsonb_build_object(
                'type', 'text',
                'binding', 'addresses.destination.line1',
                'x', 12,
                'y', 60,
                'font', 'open_sans_regular',
                'size', 12
            )
        )
    ),
    jsonb_build_array(
        jsonb_build_object(
            'name', 'primary_logo',
            'storage_key', 'labels/assets/default-logo.png',
            'content_type', 'image/png'
        )
    ),
    NULL
FROM organizations o
ON CONFLICT (organization_id, template_key, version) DO NOTHING;

-- =============================================================================
-- SECTION 4: Label job queue (label_jobs)
-- =============================================================================

CREATE TABLE label_jobs (
    id UUID DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    shipment_id UUID NOT NULL,
    shipment_box_id UUID REFERENCES shipment_boxes(id) ON DELETE SET NULL,
    label_id UUID,
    label_type TEXT NOT NULL,
    template_id UUID NOT NULL,
    template_version INTEGER NOT NULL,
    template_snapshot JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_attempt_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    job_purpose TEXT NOT NULL DEFAULT 'primary',
    idempotency_key TEXT NOT NULL,
    requested_by UUID,
    requested_source TEXT,
    renderer_hint TEXT,
    output_file_url TEXT,
    output_file_size_bytes INTEGER,
    renderer_metadata JSONB DEFAULT '{}',
    error_reason TEXT,
    retry_state JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (id, organization_id),
    CONSTRAINT label_jobs_status_chk CHECK (status IN ('pending', 'in_progress', 'succeeded', 'failed')),
    CONSTRAINT label_jobs_job_purpose_chk CHECK (job_purpose IN ('primary', 'reprint', 'manual')),
    CONSTRAINT label_jobs_template_snapshot_obj CHECK (jsonb_typeof(template_snapshot) = 'object'),
    CONSTRAINT label_jobs_retry_state_array CHECK (jsonb_typeof(retry_state) = 'array'),
    CONSTRAINT label_jobs_unique_request UNIQUE NULLS NOT DISTINCT (
        organization_id,
        shipment_id,
        shipment_box_id,
        label_type,
        template_id,
        job_purpose,
        idempotency_key
    ),
    CONSTRAINT label_jobs_template_fk FOREIGN KEY (template_id, organization_id)
        REFERENCES label_template_specs (id, organization_id)
) PARTITION BY HASH (organization_id);

CREATE TABLE label_jobs_p0
    PARTITION OF label_jobs
    FOR VALUES WITH (MODULUS 1, REMAINDER 0);

CREATE INDEX idx_label_jobs_p0_status_schedule
    ON label_jobs_p0 (status, scheduled_at, attempts);

CREATE INDEX idx_label_jobs_p0_status_attempts
    ON label_jobs_p0 (status, attempts, lease_expires_at);

CREATE INDEX idx_label_jobs_p0_shipment
    ON label_jobs_p0 (shipment_id);

CREATE INDEX idx_label_jobs_p0_template
    ON label_jobs_p0 (template_id, template_version);

COMMENT ON TABLE label_jobs IS 'Queue of label render jobs, including template snapshot, retries, and lifecycle metadata.';

COMMENT ON COLUMN label_jobs.job_purpose IS 'Identifies why the job exists: primary generation, reprint, or manual invocation.';

COMMENT ON COLUMN label_jobs.retry_state IS 'Array storing retry bookkeeping (per-attempt backoff windows, custom metadata).';

CREATE OR REPLACE FUNCTION label_jobs_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_label_jobs_set_updated_at
    BEFORE UPDATE ON label_jobs
    FOR EACH ROW
    EXECUTE FUNCTION label_jobs_set_updated_at();

CREATE OR REPLACE FUNCTION label_jobs_enforce_template_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.template_id <> OLD.template_id
        OR NEW.template_version <> OLD.template_version
        OR NEW.template_snapshot IS DISTINCT FROM OLD.template_snapshot THEN
        RAISE EXCEPTION 'Template fields are immutable once the job is created.';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_label_jobs_immutable_template
    BEFORE UPDATE ON label_jobs
    FOR EACH ROW
    WHEN (OLD.template_id IS NOT NULL)
    EXECUTE FUNCTION label_jobs_enforce_template_immutability();

ALTER TABLE label_jobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE label_jobs FROM anon;

REVOKE ALL ON TABLE label_jobs FROM authenticated;

CREATE POLICY label_jobs_select_authenticated
    ON label_jobs
    FOR SELECT
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY label_jobs_service_all
    ON label_jobs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

ALTER TABLE labels
    ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

ALTER TABLE labels
    ADD COLUMN IF NOT EXISTS renderer_metadata JSONB DEFAULT '{}'::jsonb;

-- =============================================================================
-- SECTION 5: Canonical payload projection for label rendering
-- =============================================================================

CREATE OR REPLACE VIEW shipment_label_payload_v AS
SELECT
    s.organization_id,
    s.client_id,
    s.sender_id,
    s.id AS shipment_id,
    s.status AS shipment_status,
    s.tracking_number,
    s.carrier_reference_number,
    s.client_reference_number,
    s.service_type,
    s.cod_amount,
    s.cod_currency,
    s.declared_value,
    s.special_instructions,
    s.metadata AS shipment_metadata,
    s.created_at AS shipment_created_at,
    sb.id AS shipment_box_id,
    sb.box_number,
    sb.barcode,
    sb.weight_kg,
    sb.length_cm,
    sb.width_cm,
    sb.height_cm,
    sb.volumetric_weight_kg,
    sb.fragile,
    sb.hazmat,
    r.id AS recipient_id,
    r.name AS recipient_name,
    r.phone_number AS recipient_phone,
    r.email AS recipient_email,
    r.preferred_language,
    dest.id AS destination_address_id,
    dest.raw_input AS destination_raw_input,
    dest.normalized_line1 AS destination_line1,
    dest.normalized_line2 AS destination_line2,
    dest.district AS destination_district,
    dest.city AS destination_city,
    dest.province AS destination_province,
    dest.postal_code AS destination_postal_code,
    dest.country AS destination_country,
    origin.id AS origin_address_id,
    origin.raw_input AS origin_raw_input,
    origin.normalized_line1 AS origin_line1,
    origin.normalized_line2 AS origin_line2,
    origin.city AS origin_city,
    origin.province AS origin_province,
    origin.country AS origin_country
FROM shipments s
LEFT JOIN shipment_boxes sb ON sb.shipment_id = s.id
LEFT JOIN recipients r ON r.id = s.recipient_id
LEFT JOIN addresses dest ON dest.id = s.destination_address_id
LEFT JOIN addresses origin ON origin.id = s.origin_address_id;

COMMENT ON VIEW shipment_label_payload_v IS 'Flattened payload combining shipments, boxes, recipients, and addresses for label rendering.';

-- =============================================================================
-- SECTION 6: Helper functions for template resolution and payload assembly
-- =============================================================================

CREATE OR REPLACE FUNCTION resolve_label_template(
    p_organization_id UUID,
    p_client_id UUID,
    p_sender_id UUID,
    p_label_type TEXT
)
RETURNS TABLE (
    template_id UUID,
    template_version INTEGER,
    template_snapshot JSONB,
    resolved_scope TEXT,
    max_attempts INTEGER,
    retry_backoff JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_config JSONB;
    v_template JSONB;
    v_scope TEXT;
    v_template_key TEXT;
    v_template_version INTEGER;
    v_template_record label_template_specs%ROWTYPE;
BEGIN
    IF p_label_type IS NULL OR trim(p_label_type) = '' THEN
        RAISE EXCEPTION 'label_type must be provided.';
    END IF;

    IF p_sender_id IS NOT NULL THEN
        v_config := resolve_settings('label_design', 'sender', p_sender_id);
        IF v_config IS NOT NULL THEN
            v_scope := 'sender';
        END IF;
    END IF;

    IF v_config IS NULL THEN
        v_config := resolve_settings('label_design', 'client', p_client_id);
        IF v_config IS NOT NULL THEN
            v_scope := 'client';
        END IF;
    END IF;

    IF v_config IS NULL THEN
        v_config := resolve_settings('label_design', 'tenant', p_organization_id);
        IF v_config IS NOT NULL THEN
            v_scope := 'tenant';
        END IF;
    END IF;

    IF v_config IS NULL THEN
        v_config := resolve_settings('label_design', 'global', NULL);
        v_scope := 'global';
    END IF;

    IF v_config IS NULL THEN
        RAISE EXCEPTION 'Label design configuration missing for organization %', p_organization_id;
    END IF;

    v_template := v_config -> 'templates' -> p_label_type;
    IF v_template IS NULL THEN
        v_template := v_config -> 'templates' -> 'default';
    END IF;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'Template configuration missing for label_type=% within scope=%', p_label_type, v_scope;
    END IF;

    v_template_key := v_template ->> 'template_key';
    IF v_template_key IS NULL OR trim(v_template_key) = '' THEN
        RAISE EXCEPTION 'Template configuration for label_type=% is missing template_key', p_label_type;
    END IF;

    v_template_version := NULLIF(v_template ->> 'template_version', '')::INTEGER;

    IF v_template_version IS NOT NULL THEN
        SELECT *
        INTO v_template_record
        FROM label_template_specs
        WHERE organization_id = p_organization_id
          AND template_key = v_template_key
          AND version = v_template_version
        ORDER BY version DESC
        LIMIT 1;
    ELSE
        SELECT *
        INTO v_template_record
        FROM label_template_specs
        WHERE organization_id = p_organization_id
          AND template_key = v_template_key
        ORDER BY version DESC
        LIMIT 1;
    END IF;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Template % (version %s) not found for organization %', v_template_key, COALESCE(v_template_version::TEXT, 'latest'), p_organization_id;
    END IF;

    RETURN QUERY
    SELECT
        v_template_record.id,
        v_template_record.version,
        jsonb_build_object(
            'template_key', v_template_key,
            'template_version', v_template_record.version,
            'renderer_config', v_template_record.renderer_config,
            'asset_refs', v_template_record.asset_refs,
            'resolved_scope', v_scope,
            'label_config', v_template
        ),
        v_scope,
        COALESCE(NULLIF(v_template ->> 'max_attempts', '')::INTEGER, 5),
        COALESCE(v_template -> 'retry_backoff_seconds', '[]'::jsonb);
END;
$$;

COMMENT ON FUNCTION resolve_label_template(UUID, UUID, UUID, TEXT)
    IS 'Resolve template metadata for a label request, including snapshot and retry directives.';

CREATE OR REPLACE FUNCTION request_label_generation(
    p_shipment_id UUID,
    p_label_type TEXT,
    p_requested_by UUID DEFAULT NULL,
    p_requested_source TEXT DEFAULT NULL,
    p_shipment_box_id UUID DEFAULT NULL,
    p_job_purpose TEXT DEFAULT 'primary'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_shipment RECORD;
    v_box shipment_boxes%ROWTYPE;
    v_template RECORD;
    v_job_id UUID;
    v_idempotency_key TEXT;
    v_retry_backoff JSONB;
    v_job_purpose TEXT := COALESCE(NULLIF(p_job_purpose, ''), 'primary');
    v_inserted BOOLEAN := FALSE;
BEGIN
    IF p_label_type IS NULL OR trim(p_label_type) = '' THEN
        RAISE EXCEPTION 'Label type is required.';
    END IF;

    SELECT
        s.id,
        s.organization_id,
        s.client_id,
        s.sender_id
    INTO v_shipment
    FROM shipments s
    WHERE s.id = p_shipment_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Shipment % not found', p_shipment_id;
    END IF;

    IF current_user <> 'service_role' THEN
        IF current_user_org_id() IS NULL OR current_user_org_id() <> v_shipment.organization_id THEN
            RAISE EXCEPTION 'Access denied for shipment %', p_shipment_id;
        END IF;
    END IF;

    IF p_shipment_box_id IS NOT NULL THEN
        SELECT *
        INTO v_box
        FROM shipment_boxes
        WHERE id = p_shipment_box_id
          AND shipment_id = p_shipment_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Shipment box % does not belong to shipment %', p_shipment_box_id, p_shipment_id;
        END IF;
    END IF;

    SELECT *
    INTO v_template
    FROM resolve_label_template(
        v_shipment.organization_id,
        v_shipment.client_id,
        v_shipment.sender_id,
        p_label_type
    )
    LIMIT 1;

    IF v_template.template_id IS NULL THEN
        RAISE EXCEPTION 'Unable to resolve label template for shipment % label_type %', p_shipment_id, p_label_type;
    END IF;

    v_retry_backoff := COALESCE(v_template.retry_backoff, '[]'::jsonb);
    v_idempotency_key := format(
        '%s:%s:%s:%s:%s:%s',
        v_shipment.organization_id,
        p_shipment_id,
        COALESCE(p_shipment_box_id::text, '00000000-0000-0000-0000-000000000000'),
        lower(p_label_type),
        v_template.template_id,
        v_job_purpose
    );

    INSERT INTO label_jobs (
        organization_id,
        client_id,
        shipment_id,
        shipment_box_id,
        label_type,
        template_id,
        template_version,
        template_snapshot,
        status,
        attempts,
        max_attempts,
        scheduled_at,
        job_purpose,
        idempotency_key,
        requested_by,
        requested_source,
        renderer_hint,
        retry_state
    )
    VALUES (
        v_shipment.organization_id,
        v_shipment.client_id,
        p_shipment_id,
        p_shipment_box_id,
        lower(p_label_type),
        v_template.template_id,
        v_template.template_version,
        v_template.template_snapshot,
        'pending',
        0,
        COALESCE(v_template.max_attempts, 5),
        now(),
        v_job_purpose,
        v_idempotency_key,
        p_requested_by,
        p_requested_source,
        v_template.template_snapshot -> 'label_config' ->> 'provider_hint',
        v_retry_backoff
    )
    ON CONFLICT ON CONSTRAINT label_jobs_unique_request DO NOTHING
    RETURNING id INTO v_job_id;

    IF v_job_id IS NOT NULL THEN
        v_inserted := TRUE;
    END IF;

    IF v_job_id IS NULL THEN
        SELECT id
        INTO v_job_id
        FROM label_jobs
        WHERE organization_id = v_shipment.organization_id
          AND shipment_id = p_shipment_id
          AND shipment_box_id IS NOT DISTINCT FROM p_shipment_box_id
          AND label_type = lower(p_label_type)
          AND template_id = v_template.template_id
          AND job_purpose = v_job_purpose
        ORDER BY created_at DESC
        LIMIT 1;
    END IF;

    PERFORM log_decision(
        p_organization_id := v_shipment.organization_id,
        p_decision_category := 'label_job',
        p_resource_type := 'label_job',
        p_resource_id := v_job_id,
        p_decision_point := 'request_label_generation',
        p_decision_outcome := CASE WHEN v_inserted THEN 'enqueued' ELSE 'reused' END,
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object(
            'shipment_id', p_shipment_id,
            'shipment_box_id', p_shipment_box_id,
            'label_type', lower(p_label_type),
            'template_id', v_template.template_id,
            'template_version', v_template.template_version,
            'job_purpose', v_job_purpose
        ),
        p_decision_reason := CASE WHEN v_inserted THEN NULL ELSE 'idempotent_reuse' END
    );

    RETURN v_job_id;
END;
$$;

COMMENT ON FUNCTION request_label_generation(UUID, TEXT, UUID, TEXT, UUID, TEXT)
    IS 'Create or return an idempotent label job for a shipment and label type.';

CREATE OR REPLACE FUNCTION compose_label_payload(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_job label_jobs%ROWTYPE;
    v_payload JSONB;
BEGIN
    SELECT *
    INTO v_job
    FROM label_jobs
    WHERE id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label job % not found', p_job_id;
    END IF;

    IF current_user <> 'service_role' THEN
        IF current_user_org_id() IS NULL OR current_user_org_id() <> v_job.organization_id THEN
            RAISE EXCEPTION 'Access denied for label job %', p_job_id;
        END IF;
    END IF;

    SELECT to_jsonb(payload)
    INTO v_payload
    FROM shipment_label_payload_v payload
    WHERE payload.shipment_id = v_job.shipment_id
      AND (
            v_job.shipment_box_id IS NULL
            OR payload.shipment_box_id = v_job.shipment_box_id
          )
    ORDER BY payload.box_number NULLS FIRST
    LIMIT 1;

    RETURN jsonb_build_object(
        'job', jsonb_build_object(
            'id', v_job.id,
            'organization_id', v_job.organization_id,
            'client_id', v_job.client_id,
            'shipment_id', v_job.shipment_id,
            'shipment_box_id', v_job.shipment_box_id,
            'label_type', v_job.label_type,
            'attempts', v_job.attempts,
            'max_attempts', v_job.max_attempts,
            'template', v_job.template_snapshot,
            'renderer_hint', v_job.renderer_hint,
            'retry_state', v_job.retry_state
        ),
        'payload', COALESCE(v_payload, '{}'::jsonb)
    );
END;
$$;

COMMENT ON FUNCTION compose_label_payload(UUID)
    IS 'Return canonical payload + template snapshot for a label job.';

CREATE OR REPLACE FUNCTION lease_label_job(
    p_organization_id UUID DEFAULT NULL,
    p_lease_seconds INTEGER DEFAULT 300,
    p_job_id UUID DEFAULT NULL
)
RETURNS label_jobs
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_job label_jobs%ROWTYPE;
    v_lease_interval INTERVAL := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 300), 60));
BEGIN
    IF p_job_id IS NOT NULL THEN
        SELECT *
        INTO v_job
        FROM label_jobs
        WHERE id = p_job_id
          AND status = 'pending'
        FOR UPDATE;

        IF NOT FOUND THEN
            RETURN NULL;
        END IF;

        IF p_organization_id IS NOT NULL
           AND v_job.organization_id <> p_organization_id THEN
            RAISE EXCEPTION 'Label job % does not belong to organization %', p_job_id, p_organization_id;
        END IF;

        UPDATE label_jobs
        SET status = 'in_progress',
            attempts = label_jobs.attempts + 1,
            last_attempt_at = now(),
            lease_expires_at = now() + v_lease_interval
        WHERE id = v_job.id
        RETURNING * INTO v_job;

        RETURN v_job;
    END IF;

    WITH candidate AS (
        SELECT id
        FROM label_jobs
        WHERE status = 'pending'
          AND scheduled_at <= now()
          AND attempts < max_attempts
          AND (p_organization_id IS NULL OR organization_id = p_organization_id)
          AND p_job_id IS NULL
        ORDER BY scheduled_at, created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    UPDATE label_jobs lj
    SET status = 'in_progress',
        attempts = lj.attempts + 1,
        last_attempt_at = now(),
        lease_expires_at = now() + v_lease_interval
    FROM candidate
    WHERE lj.id = candidate.id
    RETURNING lj.*
    INTO v_job;

    RETURN v_job;
END;
$$;

COMMENT ON FUNCTION lease_label_job(UUID, INTEGER, UUID)
    IS 'Lease the next pending label job, marking it in progress and returning the row.';

CREATE OR REPLACE FUNCTION complete_label_job(
    p_job_id UUID,
    p_status TEXT,
    p_file_url TEXT,
    p_file_size_bytes INTEGER,
    p_renderer_metadata JSONB DEFAULT NULL,
    p_error_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_job label_jobs%ROWTYPE;
    v_now TIMESTAMPTZ := now();
    v_barcode TEXT;
    v_barcode_format TEXT;
    v_label_id UUID;
    v_label_metadata JSONB;
    v_retry_seconds INTEGER;
    v_retry_length INTEGER;
    v_index INTEGER;
    v_max_delay INTEGER := 3600;
BEGIN
    SELECT *
    INTO v_job
    FROM label_jobs
    WHERE id = p_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label job % not found', p_job_id;
    END IF;

    IF current_user <> 'service_role' THEN
        IF current_user_org_id() IS NULL OR current_user_org_id() <> v_job.organization_id THEN
            RAISE EXCEPTION 'Access denied for label job %', p_job_id;
        END IF;
    END IF;

    IF lower(p_status) = 'succeeded' THEN
        IF v_job.shipment_box_id IS NOT NULL THEN
            SELECT barcode
            INTO v_barcode
            FROM shipment_boxes
            WHERE id = v_job.shipment_box_id;
        END IF;

        IF v_barcode IS NULL THEN
            SELECT sb.barcode
            INTO v_barcode
            FROM shipment_boxes sb
            WHERE sb.shipment_id = v_job.shipment_id
            ORDER BY sb.box_number
            LIMIT 1;
        END IF;

        v_barcode := COALESCE(
            v_barcode,
            v_job.template_snapshot -> 'label_config' ->> 'fallback_barcode'
        );

        IF v_barcode IS NULL THEN
            RAISE EXCEPTION 'Unable to resolve barcode for label job %', p_job_id;
        END IF;

        v_barcode_format := COALESCE(
            v_job.template_snapshot -> 'label_config' ->> 'barcode_format',
            v_job.template_snapshot -> 'renderer_config' -> 'barcode' ->> 'type',
            'CODE128'
        );

        v_label_id := COALESCE(v_job.label_id, gen_random_uuid());

        v_label_metadata := jsonb_build_object(
            'label_job_id', v_job.id,
            'template', v_job.template_snapshot
        );

        INSERT INTO labels (
            id,
            shipment_id,
            label_type,
            barcode,
            barcode_format,
            layout_template_id,
            file_url,
            file_size_bytes,
            generated_by,
            generated_at,
            print_count,
            last_printed_at,
            metadata,
            renderer_metadata
        )
        VALUES (
            v_label_id,
            v_job.shipment_id,
            v_job.label_type,
            v_barcode,
            v_barcode_format,
            v_job.template_id,
            p_file_url,
            COALESCE(p_file_size_bytes, 0),
            v_job.requested_by,
            v_now,
            1,
            v_now,
            v_label_metadata,
            COALESCE(p_renderer_metadata, '{}'::jsonb)
        )
        ON CONFLICT (id, shipment_id) DO UPDATE
        SET file_url = EXCLUDED.file_url,
            file_size_bytes = EXCLUDED.file_size_bytes,
            generated_by = EXCLUDED.generated_by,
            generated_at = EXCLUDED.generated_at,
            last_printed_at = EXCLUDED.last_printed_at,
            print_count = labels.print_count + 1,
            metadata = EXCLUDED.metadata,
            renderer_metadata = EXCLUDED.renderer_metadata;

        UPDATE label_jobs
        SET status = 'succeeded',
            completed_at = v_now,
            lease_expires_at = NULL,
            output_file_url = p_file_url,
            output_file_size_bytes = COALESCE(p_file_size_bytes, 0),
            renderer_metadata = COALESCE(p_renderer_metadata, '{}'::jsonb),
            error_reason = NULL,
            label_id = v_label_id
        WHERE id = v_job.id;

        INSERT INTO shipment_actions (
            id,
            shipment_id,
            action_type,
            action_category,
            action_data,
            timestamp,
            created_at,
            performed_by_system
        )
        VALUES (
            gen_random_uuid(),
            v_job.shipment_id,
            'label_generated',
            'operational',
            jsonb_build_object(
                'label_job_id', v_job.id,
                'label_id', v_label_id,
                'attempts', v_job.attempts,
                'template_version', v_job.template_version
            ),
            v_now,
            v_now,
            'label_renderer'
        );

        PERFORM log_decision(
            p_organization_id := v_job.organization_id,
            p_decision_category := 'label_job',
            p_resource_type := 'label_job',
            p_resource_id := v_job.id,
            p_decision_point := 'complete_label_job',
            p_decision_outcome := 'render_succeeded',
            p_performed_by_system := 'label_renderer',
            p_correlation_id := NULL,
            p_decision_inputs := jsonb_build_object(
                'label_id', v_label_id,
                'file_url', p_file_url,
                'file_size_bytes', COALESCE(p_file_size_bytes, 0),
                'attempts', v_job.attempts + 1,
                'template_id', v_job.template_id,
                'template_version', v_job.template_version
            )
        );
    ELSE
        v_retry_length := COALESCE(jsonb_array_length(v_job.retry_state), 0);
        IF v_retry_length >= v_job.attempts AND v_job.attempts > 0 THEN
            v_index := v_job.attempts;
            v_retry_seconds := COALESCE((v_job.retry_state ->> (v_index - 1))::INTEGER, 0);
        ELSE
            v_retry_seconds := 0;
        END IF;
        IF v_retry_seconds <= 0 THEN
            v_retry_seconds := LEAST(v_max_delay, 60 * (2 ^ GREATEST(v_job.attempts - 1, 0)));
        END IF;
        v_retry_seconds := LEAST(v_max_delay, GREATEST(v_retry_seconds, 30));

        IF v_job.attempts >= v_job.max_attempts THEN
            UPDATE label_jobs
            SET status = 'failed',
                completed_at = v_now,
                lease_expires_at = NULL,
                renderer_metadata = COALESCE(p_renderer_metadata, '{}'::jsonb),
                error_reason = COALESCE(p_error_reason, 'max_attempts_exceeded')
            WHERE id = v_job.id;

            PERFORM log_decision(
                p_organization_id := v_job.organization_id,
                p_decision_category := 'label_job',
                p_resource_type := 'label_job',
                p_resource_id := v_job.id,
                p_decision_point := 'complete_label_job',
                p_decision_outcome := 'render_failed',
                p_performed_by_system := 'label_renderer',
                p_correlation_id := NULL,
                p_decision_inputs := jsonb_build_object(
                    'attempts', v_job.attempts,
                    'max_attempts', v_job.max_attempts,
                    'template_id', v_job.template_id,
                    'template_version', v_job.template_version
                ),
                p_decision_reason := COALESCE(p_error_reason, 'max_attempts_exceeded')
            );
        ELSE
            UPDATE label_jobs
            SET status = 'pending',
                lease_expires_at = NULL,
                scheduled_at = v_now + make_interval(secs => v_retry_seconds),
                renderer_metadata = COALESCE(p_renderer_metadata, '{}'::jsonb),
                error_reason = p_error_reason
            WHERE id = v_job.id;

            PERFORM log_decision(
                p_organization_id := v_job.organization_id,
                p_decision_category := 'label_job',
                p_resource_type := 'label_job',
                p_resource_id := v_job.id,
                p_decision_point := 'complete_label_job',
                p_decision_outcome := 'render_retry_scheduled',
                p_performed_by_system := 'label_renderer',
                p_correlation_id := NULL,
                p_decision_inputs := jsonb_build_object(
                    'next_attempt_in_seconds', v_retry_seconds,
                    'attempts', v_job.attempts,
                    'max_attempts', v_job.max_attempts,
                    'template_id', v_job.template_id,
                    'template_version', v_job.template_version
                ),
                p_decision_reason := p_error_reason
            );
        END IF;
    END IF;
END;
$$;

COMMENT ON FUNCTION complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT)
    IS 'Mark a label job as succeeded or failed, updating label records and scheduling retries.';

CREATE OR REPLACE FUNCTION request_label_reprint(
    p_label_id UUID,
    p_actor_id UUID DEFAULT NULL,
    p_requested_source TEXT DEFAULT 'reprint'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_label RECORD;
    v_template_snapshot JSONB;
    v_template_version INTEGER;
    v_template_id UUID;
    v_retry JSONB;
    v_max_attempts INTEGER;
    v_job_id UUID;
BEGIN
    SELECT
        l.*,
        s.organization_id,
        s.client_id,
        s.sender_id,
        sb.id AS matched_box_id
    INTO v_label
    FROM labels l
    JOIN shipments s ON s.id = l.shipment_id
    LEFT JOIN shipment_boxes sb ON sb.barcode = l.barcode
    WHERE l.id = p_label_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label % not found', p_label_id;
    END IF;

    IF current_user <> 'service_role' THEN
        IF current_user_org_id() IS NULL OR current_user_org_id() <> v_label.organization_id THEN
            RAISE EXCEPTION 'Access denied for label %', p_label_id;
        END IF;
    END IF;

    v_template_snapshot := COALESCE(v_label.metadata -> 'template', '{}'::jsonb);

    IF jsonb_typeof(v_template_snapshot) IS DISTINCT FROM 'object'
        OR v_template_snapshot = '{}'::jsonb THEN
        SELECT
            rt.template_snapshot,
            rt.template_version,
            rt.template_id,
            rt.max_attempts,
            rt.retry_backoff
        INTO v_template_snapshot,
             v_template_version,
             v_template_id,
             v_max_attempts,
             v_retry
        FROM resolve_label_template(
            v_label.organization_id,
            v_label.client_id,
            v_label.sender_id,
            v_label.label_type
        ) AS rt
        LIMIT 1;
    ELSE
        v_template_version := COALESCE((v_template_snapshot ->> 'template_version')::INTEGER, 1);
        v_template_id := COALESCE(v_label.layout_template_id, (v_template_snapshot ->> 'template_id')::UUID);
        v_retry := COALESCE(v_template_snapshot -> 'label_config' -> 'retry_backoff_seconds', '[]'::jsonb);
        v_max_attempts := COALESCE((v_template_snapshot -> 'label_config' ->> 'max_attempts')::INTEGER, 5);
    END IF;

    IF v_template_id IS NULL THEN
        RAISE EXCEPTION 'Template reference missing for label %', p_label_id;
    END IF;

    INSERT INTO label_jobs (
        organization_id,
        client_id,
        shipment_id,
        shipment_box_id,
        label_id,
        label_type,
        template_id,
        template_version,
        template_snapshot,
        status,
        attempts,
        max_attempts,
        scheduled_at,
        job_purpose,
        idempotency_key,
        requested_by,
        requested_source,
        renderer_hint,
        retry_state
    )
    VALUES (
        v_label.organization_id,
        v_label.client_id,
        v_label.shipment_id,
        v_label.matched_box_id,
        p_label_id,
        v_label.label_type,
        v_template_id,
        v_template_version,
        v_template_snapshot,
        'pending',
        0,
        COALESCE(v_max_attempts, 5),
        now(),
        'reprint',
        gen_random_uuid()::text,
        p_actor_id,
        p_requested_source,
        v_template_snapshot -> 'label_config' ->> 'provider_hint',
        COALESCE(v_retry, '[]'::jsonb)
    )
    RETURNING id INTO v_job_id;

    RETURN v_job_id;
END;
$$;

COMMENT ON FUNCTION request_label_reprint(UUID, UUID, TEXT)
    IS 'Queue a reprint job using the original template snapshot stored on the label.';

CREATE OR REPLACE FUNCTION reclaim_stale_label_jobs(
    p_limit INTEGER DEFAULT 500,
    p_timeout_seconds INTEGER DEFAULT 600
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_processed INTEGER := 0;
BEGIN
    WITH stale AS (
        SELECT id
        FROM label_jobs
        WHERE status = 'in_progress'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= now() - make_interval(secs => GREATEST(COALESCE(p_timeout_seconds, 600), 60))
        ORDER BY lease_expires_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    ),
    updated AS (
        UPDATE label_jobs lj
        SET status = 'pending',
            lease_expires_at = NULL,
            scheduled_at = now(),
            error_reason = COALESCE(lj.error_reason, 'lease_expired'),
            renderer_metadata = COALESCE(lj.renderer_metadata, '{}'::jsonb) || jsonb_build_object(
                'reclaimed_at', now(),
                'reclaim_reason', 'lease_expired'
            )
        FROM stale
        WHERE lj.id = stale.id
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_processed FROM updated;

    RETURN COALESCE(v_processed, 0);
END;
$$;

COMMENT ON FUNCTION reclaim_stale_label_jobs(INTEGER, INTEGER)
    IS 'Requeue expired in-progress label jobs whose lease has timed out.';

-- =============================================================================
-- SECTION 7: Schedule reclaim job via pg_cron
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'label_jobs_reclaim') THEN
        PERFORM cron.unschedule('label_jobs_reclaim');
    END IF;
END;
$$;

SELECT cron.schedule(
    'label_jobs_reclaim',
    '*/5 * * * *',
    $$SELECT reclaim_stale_label_jobs(500, 600);$$
);

COMMIT;

WITH default_label_provider AS (
    SELECT
        '77770000-0000-0000-0000-000000000102'::uuid AS settings_version_id,
        jsonb_build_object(
            'version', 1,
            'providers', jsonb_build_array(
                jsonb_build_object(
                    'name', 'internal_renderer',
                    'mode', 'internal',
                    'timeout_ms', 15000
                )
            )
        ) AS payload
),
upsert_label_provider AS (
    INSERT INTO settings_versions (
        id,
        category,
        scope_type,
        scope_id,
        scope_hash,
        version,
        value,
        schema_version,
        change_reason,
        approved_at,
        effective_from
    )
    SELECT
        settings_version_id,
        'label_provider',
        'global',
        NULL,
        '00000000-0000-0000-0000-000000000000'::uuid,
        1,
        payload,
        1,
        'Initial global label provider baseline',
        workflow_now(),
        workflow_now()
    FROM default_label_provider
    ON CONFLICT (id, scope_hash) DO UPDATE
    SET value = EXCLUDED.value,
        change_reason = EXCLUDED.change_reason,
        approved_at = EXCLUDED.approved_at,
        effective_from = EXCLUDED.effective_from
    RETURNING id, value
)
INSERT INTO settings (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
)
SELECT
    '66660000-0000-0000-0000-000000000102',
    'label_provider',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    id,
    value,
    workflow_now()
FROM upsert_label_provider
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated
