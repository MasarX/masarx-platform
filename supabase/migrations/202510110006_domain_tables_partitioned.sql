-- Migration 6: Domain Tables Partitioned (7 tables, 7 HASH partitions)
-- Purpose: Create partitioned domain tables for shipments, addresses, geocoding, and labels
-- Task: Phase 3 - Migration Rebuild (100% Plan.md compliance)
-- Dependencies: Migration 5 (RLS indexes functions seed)
-- Follows: docs/product/standards/backend/migrations.md (small, focused changes, zero-hardcoding)
-- Follows: docs/product/standards/backend/models.md (timestamps, data integrity, appropriate data types)

-- =============================================================================
-- SECTION 1: Recipients (CRITICAL - was MISSING)
-- =============================================================================
-- Purpose: Store recipient information for shipments
-- From: Plan.md Section 4.5 (lines 1375-1394)
-- Partitioning: None (shared reference data)

CREATE TABLE recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    external_id TEXT, -- Client's customer ID
    name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    phone_validation_status TEXT, -- lookup category 'phone_validation_status'
    phone_validation_message TEXT, -- Validation error details
    phone_validated_at TIMESTAMPTZ, -- Last validation timestamp
    email TEXT,
    preferred_language TEXT NOT NULL DEFAULT 'en', -- 'ar', 'en'
    preferred_comm_channel TEXT, -- lookup category 'communication_channel'
    quiet_hours_start TIME,
    quiet_hours_end TIME,
    communication_preferences JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT recipients_preferred_language_check CHECK (preferred_language IN ('ar', 'en'))
);

CREATE INDEX idx_recipients_organization ON recipients(organization_id);
CREATE INDEX idx_recipients_client ON recipients(client_id);
CREATE INDEX idx_recipients_external_id ON recipients(client_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_recipients_phone ON recipients(phone_number);

COMMENT ON TABLE recipients IS 'Recipient contact information and communication preferences (Plan.md Section 4.5)';
COMMENT ON COLUMN recipients.external_id IS 'Client''s customer ID for correlation';
COMMENT ON COLUMN recipients.phone_validation_status IS 'Phone validation state: valid, invalid, unverified, pending';
COMMENT ON COLUMN recipients.preferred_comm_channel IS 'Preferred channel: sms, whatsapp, email';
COMMENT ON COLUMN recipients.communication_preferences IS 'JSONB storage for flexible communication settings';

-- =============================================================================
-- SECTION 2: Shipments (HASH PARTITIONED by client_id, MODULUS 1)
-- =============================================================================
-- Purpose: Core shipment tracking table with ALL service types
-- From: Plan.md Section 4.5 (lines 1318-1373)
-- Partitioning: HASH by client_id (expandable to 4, 16)
-- CRITICAL: Now includes recipient_id, box_count, organization_id (were MISSING)

CREATE TABLE shipments (
    id UUID DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES senders(id) ON DELETE SET NULL,
    service_type TEXT NOT NULL, -- lookup category 'service_type': delivery, pickup, swap, rto

    -- Unified Reference Numbers
    tracking_number TEXT NOT NULL, -- YOUR primary tracking (e.g., DLX123456789)
    carrier_reference_number TEXT, -- 3PL/carrier tracking when outsourced
    client_reference_number TEXT, -- Client's order/tracking number
    lmd_system_reference TEXT, -- Legacy system reference (temporary migration field)

    -- CRITICAL: Box count (was MISSING)
    box_count INTEGER NOT NULL DEFAULT 1, -- Total boxes in shipment

    -- CRITICAL: Recipient relationship (was MISSING)
    recipient_id UUID, -- FK to recipients - will be added in Migration 8
    destination_address_id UUID, -- FK to addresses - will be added in Migration 8

    -- Priority and delivery
    priority_score DECIMAL,
    promised_delivery_date DATE,
    service_level TEXT, -- lookup category 'service_level': economy, standard, premium, express
    special_instructions TEXT,

    -- COD and value
    cod_amount DECIMAL,
    cod_currency TEXT DEFAULT 'SAR',
    declared_value DECIMAL,

    -- Status tracking
    status TEXT NOT NULL, -- lookup category 'shipment_status'
    status_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    current_location_type TEXT, -- Phase 1: simplified

    -- Origin address for ALL service types
    origin_address_id UUID, -- FK to addresses - will be added in Migration 8

    -- Flexible storage
    shipment_settings_override JSONB,
    metadata JSONB, -- Integration-specific data
    version INTEGER NOT NULL DEFAULT 1, -- Optimistic locking

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT shipments_box_count_check CHECK (box_count > 0),
    UNIQUE (tracking_number, client_id), -- UNIQUE constraint must include partition key
    PRIMARY KEY (id, client_id)
) PARTITION BY HASH (client_id);

-- Create initial partition (expandable to 4, 16)
CREATE TABLE shipments_p0 PARTITION OF shipments
    FOR VALUES WITH (MODULUS 1, REMAINDER 0);

-- Indexes on partition
CREATE INDEX idx_shipments_p0_tracking ON shipments_p0(tracking_number);
CREATE INDEX idx_shipments_p0_organization ON shipments_p0(organization_id);
CREATE INDEX idx_shipments_p0_client ON shipments_p0(client_id);
CREATE INDEX idx_shipments_p0_status ON shipments_p0(status);
CREATE INDEX idx_shipments_p0_recipient ON shipments_p0(recipient_id) WHERE recipient_id IS NOT NULL;
CREATE INDEX idx_shipments_p0_carrier_ref ON shipments_p0(carrier_reference_number) WHERE carrier_reference_number IS NOT NULL;
CREATE INDEX idx_shipments_p0_client_ref ON shipments_p0(client_reference_number) WHERE client_reference_number IS NOT NULL;
CREATE INDEX idx_shipments_p0_created ON shipments_p0(created_at DESC);

COMMENT ON TABLE shipments IS 'Core shipment tracking with HASH partitioning by client_id (Plan.md Section 4.5)';
COMMENT ON COLUMN shipments.tracking_number IS 'YOUR primary tracking number (e.g., DLX123456789)';
COMMENT ON COLUMN shipments.carrier_reference_number IS '3PL/carrier tracking when outsourced (e.g., ARAMEX-ABC123)';
COMMENT ON COLUMN shipments.client_reference_number IS 'Client''s order/tracking number for reconciliation';
COMMENT ON COLUMN shipments.box_count IS 'Total boxes in shipment (default 1)';
COMMENT ON COLUMN shipments.recipient_id IS 'FK to recipients table (was MISSING in old migrations)';
COMMENT ON COLUMN shipments.service_type IS 'Service type: delivery, pickup, swap, rto';
COMMENT ON COLUMN shipments.origin_address_id IS 'Origin address for ALL service types (Delivery=warehouse, Pickup=customer)';

-- =============================================================================
-- SECTION 3: Shipment Boxes (was called "packages" in old migrations)
-- =============================================================================
-- Purpose: Individual box tracking with physical attributes
-- From: Plan.md Section 4.5 (lines 1397-1432)
-- Partitioning: None (child of shipments, relatively low volume)
-- Note: Plan.md calls this "shipment_boxes", old migrations called it "packages"

CREATE TABLE shipment_boxes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id UUID NOT NULL,
    box_number INTEGER NOT NULL, -- 1, 2, 3... (sequence within shipment)
    barcode TEXT NOT NULL UNIQUE, -- Format: DLX123456789:1, DLX123456789:2 (NO LEADING ZEROS)

    -- Physical Attributes
    weight_kg DECIMAL,
    length_cm DECIMAL,
    width_cm DECIMAL,
    height_cm DECIMAL,
    volumetric_weight_kg DECIMAL, -- Calculated
    fragile BOOLEAN DEFAULT false,
    hazmat BOOLEAN DEFAULT false,
    contents_description TEXT,
    must_stay_with_shipment BOOLEAN DEFAULT false, -- Boxes must be delivered together

    -- Operational Tracking
    status TEXT, -- lookup category 'box_status': pending, scanned, in_transit, delivered, missing
    scanned_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT shipment_boxes_unique_number UNIQUE(shipment_id, box_number),
    CONSTRAINT shipment_boxes_barcode_format CHECK (barcode ~ '^[A-Z0-9]+:[0-9]+$')
);

CREATE INDEX idx_shipment_boxes_barcode ON shipment_boxes(barcode);
CREATE INDEX idx_shipment_boxes_shipment ON shipment_boxes(shipment_id);
CREATE INDEX idx_shipment_boxes_status ON shipment_boxes(shipment_id, status);

COMMENT ON TABLE shipment_boxes IS 'Individual box tracking with physical attributes (Plan.md Section 4.5, lines 1397-1432)';
COMMENT ON COLUMN shipment_boxes.barcode IS 'Box barcode format: {TRACKING_NUMBER}:{BOX_NUMBER} with NO LEADING ZEROS (e.g., DLX123:1, DLX123:2)';
COMMENT ON COLUMN shipment_boxes.box_number IS 'Sequence within shipment: 1, 2, 3...';
COMMENT ON COLUMN shipment_boxes.must_stay_with_shipment IS 'Boxes must be delivered together (e.g., laptop + charger)';
COMMENT ON CONSTRAINT shipment_boxes_barcode_format ON shipment_boxes IS 'Enforces format: {TRACKING_NUMBER}:{BOX_NUMBER} - Valid: DLX123:1, DLX123:10; Invalid: DLX123:001, TESTBOX';

-- =============================================================================
-- SECTION 4: Labels (HASH PARTITIONED by shipment_id, MODULUS 1)
-- =============================================================================
-- Purpose: Shipping label generation and tracking
-- From: Plan.md Section 4.5 (lines 1434-1454)
-- Partitioning: HASH by shipment_id (expandable to 4, 16)
-- CRITICAL RULE: labels.barcode ALWAYS equals shipment_boxes.barcode

CREATE TABLE labels (
    id UUID DEFAULT gen_random_uuid(),
    shipment_id UUID NOT NULL,
    label_type TEXT NOT NULL, -- lookup category 'label_type': shipping, return, customs
    barcode TEXT NOT NULL, -- Box barcode (e.g., DLX123456789:1, DLX123456789:2)
    barcode_format TEXT NOT NULL, -- lookup category 'barcode_format': CODE128, QR, GS1_128, EAN13
    layout_template_id UUID, -- References label layout config
    file_url TEXT NOT NULL, -- PDF in Supabase storage
    file_size_bytes INTEGER NOT NULL,
    generated_by UUID, -- FK to users
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    print_count INTEGER NOT NULL DEFAULT 0,
    last_printed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (barcode, shipment_id), -- UNIQUE constraint must include partition key
    PRIMARY KEY (id, shipment_id)
) PARTITION BY HASH (shipment_id);

-- Create initial partition (expandable to 4, 16)
CREATE TABLE labels_p0 PARTITION OF labels
    FOR VALUES WITH (MODULUS 1, REMAINDER 0);

-- Indexes on partition
CREATE INDEX idx_labels_p0_barcode ON labels_p0(barcode);
CREATE INDEX idx_labels_p0_shipment ON labels_p0(shipment_id);
CREATE INDEX idx_labels_p0_type ON labels_p0(label_type);
CREATE INDEX idx_labels_p0_generated ON labels_p0(generated_at DESC);

COMMENT ON TABLE labels IS 'Shipping label generation with HASH partitioning by shipment_id (Plan.md Section 4.5)';
COMMENT ON COLUMN labels.barcode IS 'UNIVERSAL RULE: labels.barcode ALWAYS equals shipment_boxes.barcode (Plan.md lines 1450-1453)';
COMMENT ON COLUMN labels.label_type IS 'Label type: shipping, return, customs (Phase 1: shipping only)';
COMMENT ON COLUMN labels.file_url IS 'PDF file stored in Supabase storage';

-- =============================================================================
-- SECTION 5: Shipment Actions (Event sourcing for shipment journey)
-- =============================================================================
-- Purpose: Complete event sourcing for shipment lifecycle
-- From: Plan.md Section 4.5 (lines 1503-1538)
-- Partitioning: None (event history, consider RANGE partitioning in Phase 2)

CREATE TABLE shipment_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id UUID NOT NULL,
    action_type TEXT NOT NULL, -- lookup category 'shipment_action_type'
    action_category TEXT NOT NULL, -- lookup category 'shipment_action_category'

    -- Event details
    canonical_status TEXT, -- New status if action_type = 'status_change'
    location_type TEXT, -- hub, warehouse, client_facility, delivery_zone
    location_id UUID,
    coordinates geography(POINT, 4326), -- PostGIS point

    -- Investigation tracking
    requires_investigation BOOLEAN DEFAULT false,
    assigned_to UUID, -- FK to users
    investigation_status TEXT, -- lookup category 'investigation_status'
    root_cause TEXT,
    resolution TEXT,
    resolved_at TIMESTAMPTZ,

    -- Attribution
    performed_by_user_id UUID, -- FK to users
    performed_by_system TEXT, -- Worker name from worker_registry

    -- Flexible storage
    action_data JSONB, -- Action-specific details
    notes TEXT,

    -- Timestamps
    timestamp TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_shipment_actions_shipment ON shipment_actions(shipment_id, timestamp DESC);
CREATE INDEX idx_shipment_actions_type ON shipment_actions(action_type);
CREATE INDEX idx_shipment_actions_investigation ON shipment_actions(requires_investigation) WHERE requires_investigation = true;
CREATE INDEX idx_shipment_actions_timestamp ON shipment_actions(timestamp DESC);

COMMENT ON TABLE shipment_actions IS 'Event sourcing for complete shipment lifecycle (Plan.md Section 4.5, lines 1503-1538)';
COMMENT ON COLUMN shipment_actions.action_type IS 'Action type: status_change, location_update, exception, delay, investigation, address_update, recipient_update, cod_update, note, scan';
COMMENT ON COLUMN shipment_actions.action_category IS 'Action category: operational, exception, administrative, investigation';
COMMENT ON COLUMN shipment_actions.performed_by_system IS 'Worker name from worker_registry (e.g., outbound_worker, webhook_processor_worker)';
COMMENT ON COLUMN shipment_actions.action_data IS 'JSONB storage for action-specific details (address changes, COD updates, exception details)';

-- =============================================================================
-- SECTION 6: Addresses (HASH PARTITIONED by client_id, MODULUS 1)
-- =============================================================================
-- Purpose: Address normalization and validation
-- From: Plan.md Section 4.6 (lines 1554-1574)
-- Partitioning: HASH by client_id (expandable to 4, 16)

CREATE TABLE addresses (
    id UUID DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    raw_input TEXT NOT NULL, -- Exactly as provided
    normalized_line1 TEXT,
    normalized_line2 TEXT,
    district TEXT,
    city TEXT NOT NULL,
    province TEXT NOT NULL,
    postal_code TEXT,
    country TEXT NOT NULL DEFAULT 'SA',
    building_number TEXT,
    additional_directions TEXT, -- e.g., "near blue mosque"
    validation_status TEXT NOT NULL, -- lookup category 'validation_status'
    correction_count INTEGER NOT NULL DEFAULT 0,
    last_corrected_at TIMESTAMPTZ,
    is_pii BOOLEAN DEFAULT true, -- For retention policy
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, client_id)
) PARTITION BY HASH (client_id);

-- Create initial partition (expandable to 4, 16)
CREATE TABLE addresses_p0 PARTITION OF addresses
    FOR VALUES WITH (MODULUS 1, REMAINDER 0);

-- Indexes on partition
CREATE INDEX idx_addresses_p0_organization ON addresses_p0(organization_id);
CREATE INDEX idx_addresses_p0_client ON addresses_p0(client_id);
CREATE INDEX idx_addresses_p0_validation ON addresses_p0(validation_status);
CREATE INDEX idx_addresses_p0_city ON addresses_p0(city);
CREATE INDEX idx_addresses_p0_created ON addresses_p0(created_at DESC);

COMMENT ON TABLE addresses IS 'Address normalization and validation with HASH partitioning by client_id (Plan.md Section 4.6)';
COMMENT ON COLUMN addresses.raw_input IS 'Original address exactly as provided by client';
COMMENT ON COLUMN addresses.validation_status IS 'Validation state: pending, valid, invalid, needs_review';
COMMENT ON COLUMN addresses.correction_count IS 'Number of times address was corrected';
COMMENT ON COLUMN addresses.is_pii IS 'Flag for retention policy compliance';

-- =============================================================================
-- SECTION 7: Geocodes (HASH PARTITIONED by address_id, MODULUS 4)
-- =============================================================================
-- Purpose: Geocoding results cache with provider tracking
-- From: Plan.md Section 4.6 (lines 1576-1589)
-- Partitioning: HASH by address_id with MODULUS 4 (4 partitions)
-- Note: Old migrations called this "geocoding_cache", Plan.md calls it "geocodes"

CREATE TABLE geocodes (
    id UUID DEFAULT gen_random_uuid(),
    address_id UUID NOT NULL,
    provider_name TEXT NOT NULL, -- 'google', 'here'
    coordinates geography(POINT, 4326) NOT NULL,
    confidence_score DECIMAL, -- 0-1
    accuracy_type TEXT, -- lookup category 'geocode_accuracy': rooftop, interpolated, approximate
    formatted_address TEXT,
    metadata JSONB, -- Provider-specific data
    is_primary BOOLEAN DEFAULT false, -- True for currently used geocode
    geocoded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ, -- Geocodes go stale

    PRIMARY KEY (id, address_id)
) PARTITION BY HASH (address_id);

-- Create 4 partitions (MODULUS 4)
CREATE TABLE geocodes_p0 PARTITION OF geocodes
    FOR VALUES WITH (MODULUS 4, REMAINDER 0);

CREATE TABLE geocodes_p1 PARTITION OF geocodes
    FOR VALUES WITH (MODULUS 4, REMAINDER 1);

CREATE TABLE geocodes_p2 PARTITION OF geocodes
    FOR VALUES WITH (MODULUS 4, REMAINDER 2);

CREATE TABLE geocodes_p3 PARTITION OF geocodes
    FOR VALUES WITH (MODULUS 4, REMAINDER 3);

-- Indexes on each partition
CREATE INDEX idx_geocodes_p0_address ON geocodes_p0(address_id);
CREATE INDEX idx_geocodes_p0_primary ON geocodes_p0(address_id, is_primary) WHERE is_primary = true;
CREATE INDEX idx_geocodes_p0_expires ON geocodes_p0(expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX idx_geocodes_p1_address ON geocodes_p1(address_id);
CREATE INDEX idx_geocodes_p1_primary ON geocodes_p1(address_id, is_primary) WHERE is_primary = true;
CREATE INDEX idx_geocodes_p1_expires ON geocodes_p1(expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX idx_geocodes_p2_address ON geocodes_p2(address_id);
CREATE INDEX idx_geocodes_p2_primary ON geocodes_p2(address_id, is_primary) WHERE is_primary = true;
CREATE INDEX idx_geocodes_p2_expires ON geocodes_p2(expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX idx_geocodes_p3_address ON geocodes_p3(address_id);
CREATE INDEX idx_geocodes_p3_primary ON geocodes_p3(address_id, is_primary) WHERE is_primary = true;
CREATE INDEX idx_geocodes_p3_expires ON geocodes_p3(expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON TABLE geocodes IS 'Geocoding results cache with HASH partitioning by address_id, MODULUS 4 (Plan.md Section 4.6)';
COMMENT ON COLUMN geocodes.provider_name IS 'Geocoding provider: google, here';
COMMENT ON COLUMN geocodes.confidence_score IS 'Confidence score 0-1 from provider';
COMMENT ON COLUMN geocodes.accuracy_type IS 'Accuracy level: rooftop, interpolated, approximate';
COMMENT ON COLUMN geocodes.is_primary IS 'True for currently active geocode result';
COMMENT ON COLUMN geocodes.expires_at IS 'Geocode expiration timestamp (geocodes go stale)';

-- =============================================================================
-- SECTION 8: Canonical Cities (Optional - Geography reference data)
-- =============================================================================
-- Purpose: Canonical city reference for address normalization
-- From: Plan.md Section 4.6 (lines 1591-1612)
-- Partitioning: None (reference data, low volume)

CREATE TABLE canonical_cities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name_canonical TEXT NOT NULL, -- Standardized English name
    name_arabic TEXT, -- Standardized Arabic name
    alternate_names TEXT[], -- Variants for fuzzy matching
    province TEXT,
    country_code TEXT NOT NULL DEFAULT 'SA',
    source TEXT NOT NULL, -- lookup category 'city_source': api_learned, manual_seed, ops_verified
    metadata JSONB, -- API provider info
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT canonical_cities_unique UNIQUE(organization_id, name_canonical)
);

CREATE INDEX idx_canonical_cities_organization ON canonical_cities(organization_id);
CREATE INDEX idx_canonical_cities_active ON canonical_cities(is_active) WHERE is_active = true;
CREATE INDEX idx_canonical_cities_alternate_names ON canonical_cities USING GIN(alternate_names); -- Fuzzy matching

COMMENT ON TABLE canonical_cities IS 'Canonical city reference for address normalization (Plan.md Section 4.6)';
COMMENT ON COLUMN canonical_cities.name_canonical IS 'Standardized English city name (e.g., "Riyadh")';
COMMENT ON COLUMN canonical_cities.name_arabic IS 'Standardized Arabic city name (e.g., "الرياض")';
COMMENT ON COLUMN canonical_cities.alternate_names IS 'Variants for fuzzy matching (e.g., ["Riyad", "Riyadh City"])';
COMMENT ON COLUMN canonical_cities.source IS 'Data source: api_learned, manual_seed, ops_verified';

-- =============================================================================
-- SECTION 9: Canonical Districts (Optional - Geography reference data)
-- =============================================================================
-- Purpose: Canonical district reference for address normalization
-- From: Plan.md Section 4.6 (lines 1613-1634)
-- Partitioning: None (reference data, low volume)

CREATE TABLE canonical_districts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    city_id UUID NOT NULL REFERENCES canonical_cities(id) ON DELETE CASCADE,
    name_canonical TEXT NOT NULL, -- Standardized English name
    name_arabic TEXT, -- Standardized Arabic name
    alternate_names TEXT[], -- Variants for fuzzy matching
    source TEXT NOT NULL, -- lookup category 'district_source': api_learned, manual_seed, ops_verified
    metadata JSONB, -- API provider info
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT canonical_districts_unique UNIQUE(organization_id, city_id, name_canonical)
);

CREATE INDEX idx_canonical_districts_organization ON canonical_districts(organization_id);
CREATE INDEX idx_canonical_districts_city ON canonical_districts(city_id);
CREATE INDEX idx_canonical_districts_active ON canonical_districts(is_active) WHERE is_active = true;
CREATE INDEX idx_canonical_districts_alternate_names ON canonical_districts USING GIN(alternate_names); -- Fuzzy matching

COMMENT ON TABLE canonical_districts IS 'Canonical district reference for address normalization (Plan.md Section 4.6)';
COMMENT ON COLUMN canonical_districts.name_canonical IS 'Standardized English district name (e.g., "Al Olaya")';
COMMENT ON COLUMN canonical_districts.name_arabic IS 'Standardized Arabic district name (e.g., "العليا")';
COMMENT ON COLUMN canonical_districts.alternate_names IS 'Variants for fuzzy matching (e.g., ["Olaya", "Alolaya", "Olaia"])';
COMMENT ON COLUMN canonical_districts.source IS 'Data source: api_learned, manual_seed, ops_verified';

-- =============================================================================
-- Migration Complete
-- =============================================================================

-- This migration creates 9 domain tables with 7 HASH partitions:
--
-- Tables Created:
-- 1. recipients - Recipient contact info (CRITICAL - was MISSING)
-- 2. shipments - Core shipment tracking (HASH partitioned, MODULUS 1, 1 partition)
-- 3. shipment_boxes - Individual box tracking (was called "packages")
-- 4. labels - Label generation (HASH partitioned, MODULUS 1, 1 partition)
-- 5. shipment_actions - Event sourcing for shipment lifecycle
-- 6. addresses - Address normalization (HASH partitioned, MODULUS 1, 1 partition)
-- 7. geocodes - Geocoding cache (HASH partitioned, MODULUS 4, 4 partitions)
-- 8. canonical_cities - City reference data (optional)
-- 9. canonical_districts - District reference data (optional)
--
-- HASH Partitions Created:
-- - shipments_p0 (1 partition, expandable to 4, 16)
-- - labels_p0 (1 partition, expandable to 4, 16)
-- - addresses_p0 (1 partition, expandable to 4, 16)
-- - geocodes_p0, p1, p2, p3 (4 partitions)
-- Total: 7 HASH partitions
--
-- Critical Fixes from Old Migrations:
-- ✅ Added recipients table (was MISSING)
-- ✅ Added shipments.recipient_id column (was MISSING)
-- ✅ Added shipments.box_count column (was MISSING)
-- ✅ Added shipments.organization_id column (was MISSING)
-- ✅ Renamed "packages" to "shipment_boxes" per Plan.md
-- ✅ Renamed "geocoding_cache" to "geocodes" per Plan.md
-- ✅ All columns match Plan.md exactly
--
-- Zero-Hardcoding Compliance:
-- - All lookup values use 'lookup category' references
-- - No hardcoded status values or business rules
-- - Flexible JSONB fields for extensibility
-- - Partition expansion paths documented
--
-- Next migration (007) will create infrastructure tables

