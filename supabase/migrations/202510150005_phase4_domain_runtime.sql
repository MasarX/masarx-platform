-- Migration: Phase 4 - Domain Runtime Support
-- Purpose: Add supporting tables for campaign enrolments and settings caching used by workers.
-- Date: 2025-10-15

-- =============================================================================
-- campaign_enrollments
-- =============================================================================
CREATE TABLE campaign_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES senders(id) ON DELETE SET NULL,
    shipment_id UUID,
    campaign_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'enrolled',
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_dispatch_at TIMESTAMPTZ,
    metadata JSONB,

    UNIQUE (shipment_id, campaign_key),
    CONSTRAINT campaign_enrollments_shipment_fk
        FOREIGN KEY (shipment_id, client_id) REFERENCES shipments(id, client_id) ON DELETE CASCADE
);

CREATE INDEX idx_campaign_enrollments_client_status ON campaign_enrollments(client_id, status);
CREATE INDEX idx_campaign_enrollments_org_status ON campaign_enrollments(organization_id, status);

COMMENT ON TABLE campaign_enrollments IS 'Tracks campaign membership per shipment/client based on configuration-driven policies.';
COMMENT ON COLUMN campaign_enrollments.status IS 'Lifecycle: enrolled, dispatched, completed, cancelled.';
COMMENT ON COLUMN campaign_enrollments.campaign_key IS 'Identifier from campaign_policy settings.';

-- =============================================================================
-- settings_cache
-- =============================================================================
CREATE TABLE settings_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cache_key TEXT NOT NULL UNIQUE,
    resolved_value JSONB NOT NULL,
    settings_version_id UUID,
    settings_scope_id UUID,
    expires_at TIMESTAMPTZ,
    hit_count INTEGER NOT NULL DEFAULT 0,
    last_hit_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT settings_cache_settings_version_fk
        FOREIGN KEY (settings_version_id, settings_scope_id)
        REFERENCES settings_versions(id, scope_id)
);

CREATE INDEX idx_settings_cache_expires ON settings_cache(expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON TABLE settings_cache IS 'Cache of resolved configuration entries to reduce override ladder throughput.';
COMMENT ON COLUMN settings_cache.expires_at IS 'Cache invalidation timestamp.';
COMMENT ON COLUMN settings_cache.hit_count IS 'Number of times cache entry reused.';

-- Migration complete.
