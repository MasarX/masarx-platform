-- Migration: Label sections/tokens schema + validation scaffold for sectioned templates
-- Purpose: Introduce normalized sections and design tokens tables, plus validation status storage,
--          to support sectioned label templates (v1.6+) and design-time validation without hardcoding.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | ZERO-HARDCODING | ZERO-REDUNDANCY | LADDER-COMPLIANT

BEGIN;

SET search_path TO public, pg_temp;

-- ============================================================================
-- label_sections: normalized section geometry per template version
-- ============================================================================

CREATE TABLE IF NOT EXISTS label_sections (
    id UUID DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    template_id UUID NOT NULL,
    section_key TEXT NOT NULL,
    x NUMERIC NOT NULL,
    y NUMERIC NOT NULL,
    width NUMERIC NOT NULL,
    height NUMERIC NOT NULL,
    padding_top NUMERIC NOT NULL DEFAULT 0,
    padding_right NUMERIC NOT NULL DEFAULT 0,
    padding_bottom NUMERIC NOT NULL DEFAULT 0,
    padding_left NUMERIC NOT NULL DEFAULT 0,
    z_index INTEGER NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, organization_id),
    CONSTRAINT fk_label_sections_template
        FOREIGN KEY (template_id, organization_id)
        REFERENCES label_template_specs (id, organization_id)
        ON DELETE CASCADE,
    CONSTRAINT uq_label_sections_template_key UNIQUE (template_id, organization_id, section_key),
    CONSTRAINT label_sections_padding_nonneg CHECK (
        padding_top >= 0 AND padding_right >= 0 AND padding_bottom >= 0 AND padding_left >= 0
    ),
    CONSTRAINT label_sections_dim_positive CHECK (width > 0 AND height > 0)
) PARTITION BY HASH (organization_id);

CREATE TABLE IF NOT EXISTS label_sections_p0
    PARTITION OF label_sections
    FOR VALUES WITH (MODULUS 1, REMAINDER 0);

CREATE INDEX IF NOT EXISTS idx_label_sections_template ON label_sections (template_id, section_key);
CREATE INDEX IF NOT EXISTS idx_label_sections_org ON label_sections (organization_id);

ALTER TABLE label_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE label_sections_p0 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE label_sections FROM anon;
REVOKE ALL ON TABLE label_sections FROM authenticated;
REVOKE ALL ON TABLE label_sections_p0 FROM anon;
REVOKE ALL ON TABLE label_sections_p0 FROM authenticated;

DROP POLICY IF EXISTS label_sections_service_all ON label_sections;
CREATE POLICY label_sections_service_all
    ON label_sections
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS label_sections_p0_service_all ON label_sections_p0;
CREATE POLICY label_sections_p0_service_all
    ON label_sections_p0
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE label_sections IS 'Section geometry per label template version; rows are immutable per template version.';
COMMENT ON COLUMN label_sections.section_key IS 'Logical section identifier (e.g., header, barcode_band, sender, receiver, refs_cod, bottom_table).';

-- ============================================================================
-- label_design_tokens: reusable design tokens per template version
-- ============================================================================

CREATE TABLE IF NOT EXISTS label_design_tokens (
    id UUID DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    template_id UUID NOT NULL,
    token_key TEXT NOT NULL,
    token_type TEXT NOT NULL,
    value JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, organization_id),
    CONSTRAINT fk_label_design_tokens_template
        FOREIGN KEY (template_id, organization_id)
        REFERENCES label_template_specs (id, organization_id)
        ON DELETE CASCADE,
    CONSTRAINT uq_label_design_tokens UNIQUE (template_id, organization_id, token_key),
    CONSTRAINT label_design_tokens_type_chk CHECK (
        token_type IN (
            'font_size',
            'spacing',
            'band_height',
            'padding',
            'color',
            'border',
            'barcode_min_width',
            'barcode_min_height',
            'misc'
        )
    ),
    CONSTRAINT label_design_tokens_value_type_chk CHECK (
        jsonb_typeof(value) IN ('number', 'string', 'object', 'array')
    )
) PARTITION BY HASH (organization_id);

CREATE TABLE IF NOT EXISTS label_design_tokens_p0
    PARTITION OF label_design_tokens
    FOR VALUES WITH (MODULUS 1, REMAINDER 0);

CREATE INDEX IF NOT EXISTS idx_label_design_tokens_template ON label_design_tokens (template_id, token_key);
CREATE INDEX IF NOT EXISTS idx_label_design_tokens_org ON label_design_tokens (organization_id);

ALTER TABLE label_design_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE label_design_tokens_p0 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE label_design_tokens FROM anon;
REVOKE ALL ON TABLE label_design_tokens FROM authenticated;
REVOKE ALL ON TABLE label_design_tokens_p0 FROM anon;
REVOKE ALL ON TABLE label_design_tokens_p0 FROM authenticated;

DROP POLICY IF EXISTS label_design_tokens_service_all ON label_design_tokens;
CREATE POLICY label_design_tokens_service_all
    ON label_design_tokens
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS label_design_tokens_p0_service_all ON label_design_tokens_p0;
CREATE POLICY label_design_tokens_p0_service_all
    ON label_design_tokens_p0
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE label_design_tokens IS 'Design tokens (font sizes, padding, barcode minimums, etc.) per label template version.';
COMMENT ON COLUMN label_design_tokens.token_type IS 'Token classification for validation and renderer interpretation.';

-- ============================================================================
-- label_template_validation: status/errors for design-time validation
-- ============================================================================

CREATE TABLE IF NOT EXISTS label_template_validation (
    template_id UUID NOT NULL,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    validation_status TEXT NOT NULL DEFAULT 'pending',
    validated_at TIMESTAMPTZ,
    validated_by UUID REFERENCES users(id),
    validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (template_id, organization_id),
    CONSTRAINT fk_label_template_validation_template
        FOREIGN KEY (template_id, organization_id)
        REFERENCES label_template_specs (id, organization_id)
        ON DELETE CASCADE,
    CONSTRAINT label_template_validation_status_chk CHECK (
        validation_status IN ('pending', 'passed', 'failed')
    )
) PARTITION BY HASH (organization_id);

CREATE TABLE IF NOT EXISTS label_template_validation_p0
    PARTITION OF label_template_validation
    FOR VALUES WITH (MODULUS 1, REMAINDER 0);

CREATE INDEX IF NOT EXISTS idx_label_template_validation_template ON label_template_validation (template_id);
CREATE INDEX IF NOT EXISTS idx_label_template_validation_org ON label_template_validation (organization_id);

ALTER TABLE label_template_validation ENABLE ROW LEVEL SECURITY;
ALTER TABLE label_template_validation_p0 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE label_template_validation FROM anon;
REVOKE ALL ON TABLE label_template_validation FROM authenticated;
REVOKE ALL ON TABLE label_template_validation_p0 FROM anon;
REVOKE ALL ON TABLE label_template_validation_p0 FROM authenticated;

DROP POLICY IF EXISTS label_template_validation_service_all ON label_template_validation;
CREATE POLICY label_template_validation_service_all
    ON label_template_validation
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS label_template_validation_p0_service_all ON label_template_validation_p0;
CREATE POLICY label_template_validation_p0_service_all
    ON label_template_validation_p0
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE label_template_validation IS 'Design-time validation outcomes for label templates (section fit, barcode constraints, etc.).';

COMMIT;
