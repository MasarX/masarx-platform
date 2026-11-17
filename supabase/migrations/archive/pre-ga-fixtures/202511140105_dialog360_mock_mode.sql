-- Migration: Enable mock mode for Dialog360 WhatsApp provider
-- Purpose: Prevent live 360dialog requests during automated tests and enforce workflow-only execution.
-- Date: 2025-11-14

BEGIN;

UPDATE providers
SET metadata = jsonb_strip_nulls(
        COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object(
            'mock', TRUE,
            'mock_reason', 'automation'
        )
    ),
    updated_at = now()
WHERE name = 'dialog360_whatsapp';

COMMIT;
