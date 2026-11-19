-- 202605031710_lookup_tone_gap_repair_v1.sql
--
-- Later marketplace enum migrations expanded the lookup row set after the
-- Console V2 no-fallback lookup-tone contract landed. Keep the lookup SSOT
-- complete by backfilling tone metadata for those added lifecycle rows while
-- preserving any existing metadata keys.

WITH tone_source(category, value, tone) AS (
  VALUES
    ('marketplace_offer_status', 'submitted', 'info'),
    ('marketplace_offer_status', 'countered', 'warn'),
    ('marketplace_offer_status', 'accepted', 'good'),

    ('marketplace_award_status', 'pending_acceptance', 'warn'),
    ('marketplace_award_status', 'rejected', 'danger'),
    ('marketplace_award_status', 'materialized', 'good'),
    ('marketplace_award_status', 'expired', 'neutral'),

    ('marketplace_contract_status', 'pending_acceptance', 'warn'),
    ('marketplace_contract_status', 'materialized', 'good'),
    ('marketplace_contract_status', 'executing', 'info'),
    ('marketplace_contract_status', 'completed', 'good'),
    ('marketplace_contract_status', 'settled', 'good'),
    ('marketplace_contract_status', 'cancelled', 'danger'),
    ('marketplace_contract_status', 'rejected', 'danger'),
    ('marketplace_contract_status', 'disputed', 'danger'),

    ('marketplace_request_status', 'negotiation', 'warn'),
    ('marketplace_request_status', 'award_pending_acceptance', 'warn'),
    ('marketplace_request_status', 'provider_accepted', 'good'),
    ('marketplace_request_status', 'materialized', 'good'),
    ('marketplace_request_status', 'executing', 'info'),
    ('marketplace_request_status', 'in_execution', 'info'),
    ('marketplace_request_status', 'completed', 'good'),
    ('marketplace_request_status', 'settled', 'good'),
    ('marketplace_request_status', 'disputed', 'danger')
)
UPDATE public.lookup_values lv
SET metadata = jsonb_set(COALESCE(lv.metadata, '{}'::jsonb), '{tone}', to_jsonb(ts.tone), true),
    updated_at = now()
FROM public.lookup_definitions ld
JOIN tone_source ts ON ts.category = ld.category
WHERE lv.lookup_definition_id = ld.id
  AND lv.value = ts.value
  AND COALESCE(lv.metadata->>'tone', '') IS DISTINCT FROM ts.tone;
