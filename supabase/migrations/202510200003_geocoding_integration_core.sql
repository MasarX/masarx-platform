-- Migration: Restore geocoding integration core contract + ledger
-- Purpose: Recreate the deleted migration that registered the geocoding policy
--          schema, seeded ladder overrides, refreshed lookup metadata, and
--          provisioned the geocoding_attempts ledger with partitions.
-- Alignment: SIMPLE * SCALABLE * ZERO HARD CODING * PERMANENT
/* objectives:allow RLS_MISSING Justification: RLS for geocoding_attempts is enforced in subsequent hardening migrations after the partitioned ledger contract is established. */
/* objectives:allow POLICY_MISSING Justification: Policies for geocoding_attempts are introduced in later migrations to keep this core contract migration append-only and deterministic. */

BEGIN;

-- =============================================================================
-- SECTION 1: Schema registry contract (geocoding_policy.v1)
-- =============================================================================

WITH geocoding_policy_payload AS (
    SELECT
        'bbbb0000-0000-0000-0000-000000000701'::uuid AS schema_id,
        $schema$
        {
          "title": "Geocoding Policy",
          "type": "object",
          "additionalProperties": false,
          "required": [
            "version",
            "confidence_threshold",
            "provider_priority",
            "fallback_strategy",
            "provider_agreement_rules",
            "decision_workflow_id",
            "coordinate_handling",
            "address_normalization",
            "manual_review",
            "auto_learning",
            "backpressure"
          ],
          "properties": {
            "version": {
              "type": "integer",
              "minimum": 1
            },
            "confidence_threshold": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "provider_priority": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "string"
              }
            },
            "fallback_strategy": {
              "type": "string",
              "enum": [
                "try_all",
                "stop_on_confident_match",
                "stop_on_first_success"
              ]
            },
            "provider_agreement_rules": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "max_distance_difference_m",
                "if_disagree"
              ],
              "properties": {
                "max_distance_difference_m": {
                  "type": "integer",
                  "minimum": 0
                },
                "min_confidence_delta": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 1
                },
                "if_disagree": {
                  "type": "string",
                  "enum": [
                    "manual_review",
                    "fallback_provider",
                    "fail_validation"
                  ]
                }
              }
            },
            "decision_workflow_id": {
              "type": "string",
              "minLength": 1
            },
            "coordinate_handling": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "use_provided_coordinates",
                "skip_geocoding_if_provided",
                "validate_bounds",
                "country_boundary"
              ],
              "properties": {
                "use_provided_coordinates": {
                  "type": "boolean"
                },
                "skip_geocoding_if_provided": {
                  "type": "boolean"
                },
                "validate_bounds": {
                  "type": "boolean"
                },
                "country_boundary": {
                  "type": "string",
                  "minLength": 2,
                  "maxLength": 2
                },
                "max_coordinate_age_minutes": {
                  "type": "integer",
                  "minimum": 0
                },
                "fallback_to_canonical_centroid": {
                  "type": "boolean"
                }
              }
            },
            "address_normalization": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "enabled",
                "component_matching"
              ],
              "properties": {
                "enabled": {
                  "type": "boolean"
                },
                "component_matching": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "primary_strategy_lookup",
                    "primary_threshold",
                    "fallback_strategy_lookup",
                    "fallback_threshold",
                    "match_order",
                    "match_behavior"
                  ],
                  "properties": {
                    "primary_strategy_lookup": {
                      "type": "string",
                      "minLength": 1
                    },
                    "primary_threshold": {
                      "type": "number",
                      "minimum": 0
                    },
                    "fallback_strategy_lookup": {
                      "type": "string",
                      "minLength": 1
                    },
                    "fallback_threshold": {
                      "type": "number",
                      "minimum": 0
                    },
                    "match_order": {
                      "type": "array",
                      "minItems": 1,
                      "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                          "strategy_lookup"
                        ],
                        "properties": {
                          "strategy_lookup": {
                            "type": "string",
                            "minLength": 1
                          },
                          "threshold": {
                            "type": [
                              "number",
                              "integer"
                            ]
                          },
                          "stop_on_failure": {
                            "type": "boolean",
                            "default": false
                          }
                        }
                      }
                    },
                    "match_behavior": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "require_match",
                        "on_no_match_action_lookup"
                      ],
                      "properties": {
                        "require_match": {
                          "type": "boolean"
                        },
                        "on_no_match_action_lookup": {
                          "type": "string",
                          "minLength": 1
                        }
                      }
                    }
                  }
                }
              }
            },
            "manual_review": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "sla_minutes",
                "queue_assignment",
                "escalate_after_minutes"
              ],
              "properties": {
                "sla_minutes": {
                  "type": "integer",
                  "minimum": 1
                },
                "queue_assignment": {
                  "type": "string",
                  "minLength": 1
                },
                "escalate_after_minutes": {
                  "type": "integer",
                  "minimum": 1
                },
                "escalation_channel": {
                  "type": "string"
                }
              }
            },
            "auto_learning": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "enabled",
                "confidence_threshold_for_auto_learn",
                "components"
              ],
              "properties": {
                "enabled": {
                  "type": "boolean"
                },
                "confidence_threshold_for_auto_learn": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 1
                },
                "components": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "city": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "action_lookup"
                      ],
                      "properties": {
                        "action_lookup": {
                          "type": "string",
                          "minLength": 1
                        }
                      }
                    },
                    "district": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "action_lookup"
                      ],
                      "properties": {
                        "action_lookup": {
                          "type": "string",
                          "minLength": 1
                        }
                      }
                    }
                  }
                }
              }
            },
            "backpressure": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "max_queue_depth",
                "throttle_ingest_at",
                "notify_account_manager_at"
              ],
              "properties": {
                "max_queue_depth": {
                  "type": "integer",
                  "minimum": 0
                },
                "throttle_ingest_at": {
                  "type": "integer",
                  "minimum": 0
                },
                "notify_account_manager_at": {
                  "type": "integer",
                  "minimum": 0
                },
                "pause_workflow_when_full": {
                  "type": "boolean"
                }
              }
            },
            "metadata": {
              "type": "object",
              "additionalProperties": true
            }
          }
        }
        $schema$::jsonb AS schema_body,
        $example$
        {
          "version": 1,
          "confidence_threshold": 0.8,
          "provider_priority": [
            "google_maps",
            "here_maps"
          ],
          "fallback_strategy": "try_all",
          "provider_agreement_rules": {
            "max_distance_difference_m": 500,
            "if_disagree": "manual_review"
          },
          "decision_workflow_id": "workflow_geocoding_standard",
          "coordinate_handling": {
            "use_provided_coordinates": true,
            "skip_geocoding_if_provided": true,
            "validate_bounds": true,
            "country_boundary": "SA"
          },
          "address_normalization": {
            "enabled": true,
            "component_matching": {
              "primary_strategy_lookup": "{{LOOKUP:match_strategy.trigram_similarity}}",
              "primary_threshold": 0.85,
              "fallback_strategy_lookup": "{{LOOKUP:match_strategy.levenshtein}}",
              "fallback_threshold": 3,
              "match_order": [
                {
                  "strategy_lookup": "{{LOOKUP:match_strategy.exact_case_insensitive}}",
                  "stop_on_failure": false
                },
                {
                  "strategy_lookup": "{{LOOKUP:match_strategy.trigram_similarity}}",
                  "threshold": 0.85,
                  "stop_on_failure": false
                },
                {
                  "strategy_lookup": "{{LOOKUP:match_strategy.levenshtein}}",
                  "threshold": 3,
                  "stop_on_failure": false
                }
              ],
              "match_behavior": {
                "require_match": false,
                "on_no_match_action_lookup": "{{LOOKUP:no_match_action.proceed_to_api}}"
              }
            }
          },
          "manual_review": {
            "sla_minutes": 60,
            "queue_assignment": "round_robin",
            "escalate_after_minutes": 90,
            "escalation_channel": "geo_ops_on_call"
          },
          "auto_learning": {
            "enabled": true,
            "confidence_threshold_for_auto_learn": 0.9,
            "components": {
              "city": {
                "action_lookup": "{{LOOKUP:auto_learn_action.add_immediately}}"
              },
              "district": {
                "action_lookup": "{{LOOKUP:auto_learn_action.add_immediately}}"
              }
            }
          },
          "backpressure": {
            "max_queue_depth": 200,
            "throttle_ingest_at": 150,
            "notify_account_manager_at": 100
          },
          "metadata": {
            "playbook": "GEO-001",
            "notes": "Baseline geocoding policy restored 2025-10-20"
          }
        }
        $example$::jsonb AS example_body
)
INSERT INTO schema_registry (
    id,
    category,
    version,
    schema,
    description,
    examples,
    is_active
)
SELECT
    schema_id,
    'geocoding_policy',
    1,
    schema_body,
    'Geocoding policy contract controlling provider priority, normalization, auto-learning, and backpressure.',
    jsonb_build_array(example_body),
    true
FROM geocoding_policy_payload
ON CONFLICT (id) DO UPDATE
SET
    schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = EXCLUDED.is_active;

-- =============================================================================
-- SECTION 2: Ladder overrides (global, tenant, client, sender)
-- =============================================================================
-- Pre-GA rebaseline:
-- keep only canonical global geocoding defaults in active migrations.
-- tenant/client/sender test fixture overrides are seeded from test bootstrap paths.

WITH timestamp_context AS (
    SELECT workflow_now() AS ts
),
global_payload AS (
    SELECT
        '77770000-0000-0000-0000-000000000701'::uuid AS settings_version_id,
        '66660000-0000-0000-0000-000000000701'::uuid AS settings_id,
        'geocoding_policy'::text AS category,
        'global'::text AS scope_type,
        NULL::uuid AS scope_id,
        '00000000-0000-0000-0000-000000000000'::uuid AS scope_hash,
        1 AS version,
        1 AS schema_version,
        'Restore global geocoding policy baseline'::text AS change_reason,
        jsonb_build_object(
            'version', 1,
            'confidence_threshold', 0.8,
            'provider_priority', jsonb_build_array('google_maps', 'here_maps'),
            'fallback_strategy', 'try_all',
            'provider_agreement_rules', jsonb_build_object(
                'max_distance_difference_m', 500,
                'if_disagree', 'manual_review'
            ),
            'decision_workflow_id', 'workflow_geocoding_standard',
            'coordinate_handling', jsonb_build_object(
                'use_provided_coordinates', true,
                'skip_geocoding_if_provided', true,
                'validate_bounds', true,
                'country_boundary', 'SA'
            ),
            'address_normalization', jsonb_build_object(
                'enabled', true,
                'component_matching', jsonb_build_object(
                    'primary_strategy_lookup', '{{LOOKUP:match_strategy.trigram_similarity}}',
                    'primary_threshold', 0.85,
                    'fallback_strategy_lookup', '{{LOOKUP:match_strategy.levenshtein}}',
                    'fallback_threshold', 3,
                    'match_order', jsonb_build_array(
                        jsonb_build_object(
                            'strategy_lookup', '{{LOOKUP:match_strategy.exact_case_insensitive}}',
                            'stop_on_failure', false
                        ),
                        jsonb_build_object(
                            'strategy_lookup', '{{LOOKUP:match_strategy.trigram_similarity}}',
                            'threshold', 0.85,
                            'stop_on_failure', false
                        ),
                        jsonb_build_object(
                            'strategy_lookup', '{{LOOKUP:match_strategy.levenshtein}}',
                            'threshold', 3,
                            'stop_on_failure', false
                        )
                    ),
                    'match_behavior', jsonb_build_object(
                        'require_match', false,
                        'on_no_match_action_lookup', '{{LOOKUP:no_match_action.proceed_to_api}}'
                    )
                )
            ),
            'manual_review', jsonb_build_object(
                'sla_minutes', 60,
                'queue_assignment', 'round_robin',
                'escalate_after_minutes', 90,
                'escalation_channel', 'geo_ops_on_call'
            ),
            'auto_learning', jsonb_build_object(
                'enabled', true,
                'confidence_threshold_for_auto_learn', 0.9,
                'components', jsonb_build_object(
                    'city', jsonb_build_object(
                        'action_lookup', '{{LOOKUP:auto_learn_action.add_immediately}}'
                    ),
                    'district', jsonb_build_object(
                        'action_lookup', '{{LOOKUP:auto_learn_action.add_immediately}}'
                    )
                )
            ),
            'backpressure', jsonb_build_object(
                'max_queue_depth', 200,
                'throttle_ingest_at', 150,
                'notify_account_manager_at', 100,
                'pause_workflow_when_full', false
            ),
            'metadata', jsonb_build_object(
                'playbook', 'GEO-001',
                'owner', 'ops'
            )
        ) AS policy_value
    FROM timestamp_context
),
all_payloads AS (
	    SELECT
	        settings_version_id,
	        settings_id,
	        category,
        scope_type,
        scope_id,
        scope_hash,
        version,
        schema_version,
        change_reason,
	        policy_value,
	        tc.ts AS approved_at,
	        tc.ts AS effective_from,
	        tc.ts AS last_updated
	    FROM global_payload, timestamp_context tc
) ,
upsert_settings_versions AS (
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
        category,
        scope_type,
        scope_id,
        scope_hash,
        version,
        policy_value,
        schema_version,
        change_reason,
        approved_at,
        effective_from
    FROM all_payloads
    ON CONFLICT (id, scope_hash) DO UPDATE
    SET
        value = EXCLUDED.value,
        version = EXCLUDED.version,
        schema_version = EXCLUDED.schema_version,
        change_reason = EXCLUDED.change_reason,
        approved_at = COALESCE(settings_versions.approved_at, EXCLUDED.approved_at),
        effective_from = COALESCE(settings_versions.effective_from, EXCLUDED.effective_from)
    RETURNING 1
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
    settings_id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    policy_value,
    last_updated
FROM all_payloads
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;
-- =============================================================================
-- SECTION 3: Lookup metadata refresh (match_strategy, auto_learn_action, no_match_action)
-- =============================================================================

WITH lookup_ids AS (
    SELECT
        (SELECT id FROM lookup_definitions WHERE category = 'match_strategy' LIMIT 1) AS match_strategy_id,
        (SELECT id FROM lookup_definitions WHERE category = 'auto_learn_action' LIMIT 1) AS auto_learn_action_id,
        (SELECT id FROM lookup_definitions WHERE category = 'no_match_action' LIMIT 1) AS no_match_action_id,
        workflow_now() AS ts
),
lookup_rows AS (
    SELECT
        match_strategy_id AS lookup_definition_id,
        'exact_case_insensitive'::text AS value,
        'Exact Match (Case Insensitive)'::text AS label,
        'Match normalized strings exactly using LOWER().'::text AS description,
        1 AS sort_order,
        true AS is_default,
        jsonb_build_object(
            'sql_template', 'LOWER({{input}}) = LOWER({{field}})',
            'requires_extension', NULL,
            'score_expression', '1.0'
        ) AS metadata,
        ts AS now_ts
    FROM lookup_ids
    UNION ALL
    SELECT
        match_strategy_id,
        'trigram_similarity',
        'Trigram Similarity',
        'Use pg_trgm similarity and configurable threshold.',
        2,
        false,
        jsonb_build_object(
            'sql_template', 'similarity({{input}}, {{field}}) >= {{threshold}}',
            'requires_extension', 'pg_trgm',
            'score_expression', 'similarity({{input}}, {{field}})',
            'default_threshold', 0.85
        ),
        ts
    FROM lookup_ids
    UNION ALL
    SELECT
        match_strategy_id,
        'levenshtein',
        'Levenshtein Distance',
        'Use fuzzystrmatch levenshtein distance with upper bound threshold.',
        3,
        false,
        jsonb_build_object(
            'sql_template', 'levenshtein({{input}}, {{field}}) <= {{threshold}}',
            'requires_extension', 'fuzzystrmatch',
            'score_expression', '1.0 / (levenshtein({{input}}, {{field}}) + 1)',
            'default_threshold', 3
        ),
        ts
    FROM lookup_ids
    UNION ALL
    SELECT
        auto_learn_action_id,
        'add_immediately',
        'Add Without Approval',
        'Insert learned component immediately with provenance.',
        1,
        true,
        jsonb_build_object(
            'action', 'insert',
            'require_approval', false,
            'source_value', 'api_learned'
        ),
        ts
    FROM lookup_ids
    UNION ALL
    SELECT
        auto_learn_action_id,
        'queue_for_approval',
        'Queue for Ops Approval',
        'Route learned component to manual review queue.',
        2,
        false,
        jsonb_build_object(
            'action', 'queue',
            'require_approval', true,
            'sla_hours', 48,
            'approval_queue', 'address_component_review'
        ),
        ts
    FROM lookup_ids
    UNION ALL
    SELECT
        auto_learn_action_id,
        'ignore',
        'Ignore New Component',
        'Do not persist learned component automatically.',
        3,
        false,
        jsonb_build_object(
            'action', 'none'
        ),
        ts
    FROM lookup_ids
    UNION ALL
    SELECT
        no_match_action_id,
        'proceed_to_api',
        'Proceed to Geocoding API',
        'Continue to provider API using raw component values.',
        1,
        true,
        jsonb_build_object(
            'action', 'continue',
            'use_raw_input', true,
            'skip_normalization', false
        ),
        ts
    FROM lookup_ids
    UNION ALL
    SELECT
        no_match_action_id,
        'manual_review',
        'Send to Manual Review',
        'Stop automated flow and enqueue manual review task.',
        2,
        false,
        jsonb_build_object(
            'action', 'queue_manual_review',
            'skip_api', true,
            'review_queue', 'address_validation'
        ),
        ts
    FROM lookup_ids
)
INSERT INTO lookup_values (
    lookup_definition_id,
    value,
    label,
    description,
    sort_order,
    is_default,
    metadata,
    status,
    effective_from
)
SELECT
    lookup_definition_id,
    value,
    label,
    description,
    sort_order,
    is_default,
    metadata,
    'active',
    now_ts
FROM lookup_rows
WHERE lookup_definition_id IS NOT NULL
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    metadata = EXCLUDED.metadata,
    status = 'active',
    updated_at = workflow_now();
-- =============================================================================
-- SECTION 4: Geocoding attempts ledger (partitioned by address_id)
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'geocoding_attempts'
          AND n.nspname = 'public'
    ) THEN
        EXECUTE $ddl$
            CREATE TABLE public.geocoding_attempts (
                id UUID DEFAULT gen_random_uuid(),
                organization_id UUID NOT NULL REFERENCES public.organizations(id),
                client_id UUID NOT NULL REFERENCES public.clients(id),
                sender_id UUID REFERENCES public.senders(id),
                address_id UUID NOT NULL,
                workflow_run_step_id UUID REFERENCES public.workflow_run_steps(id),
                outbound_call_id UUID REFERENCES public.outbound_calls(id),
                provider_name TEXT NOT NULL,
                attempt_order INTEGER NOT NULL CHECK (attempt_order >= 1),
                attempt_type TEXT NOT NULL CHECK (attempt_type IN ('primary', 'fallback', 'retry', 'manual_review', 'cache_hit')),
                status TEXT NOT NULL CHECK (status IN ('queued', 'in_progress', 'succeeded', 'failed', 'skipped', 'deferred')),
                confidence_score NUMERIC(5,4) CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)),
                duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
                decision_outcome TEXT,
                metadata JSONB,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT geocoding_attempts_metadata_check CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object'),
                CONSTRAINT geocoding_attempts_pkey PRIMARY KEY (id, address_id),
                CONSTRAINT geocoding_attempts_address_fk FOREIGN KEY (address_id, client_id) REFERENCES public.addresses(id, client_id)
            ) PARTITION BY HASH (address_id);
        $ddl$;

        FOR i IN 0..3 LOOP
            EXECUTE format(
                'CREATE TABLE public.geocoding_attempts_p%s PARTITION OF public.geocoding_attempts FOR VALUES WITH (MODULUS 4, REMAINDER %s);',
                i,
                i
            );

            EXECUTE format(
                'CREATE INDEX geocoding_attempts_p%s_address_provider_idx ON public.geocoding_attempts_p%s (address_id, provider_name);',
                i,
                i
            );

            EXECUTE format(
                'CREATE INDEX geocoding_attempts_p%s_org_created_idx ON public.geocoding_attempts_p%s (organization_id, created_at DESC);',
                i,
                i
            );

            EXECUTE format(
                'CREATE INDEX geocoding_attempts_p%s_workflow_step_idx ON public.geocoding_attempts_p%s (workflow_run_step_id);',
                i,
                i
            );
        END LOOP;
    END IF;
END;
$$;

COMMENT ON TABLE public.geocoding_attempts IS 'Ledger of geocoding attempts with provider outcomes, durations, and decision metadata.';
COMMENT ON COLUMN public.geocoding_attempts.attempt_type IS 'Lookup category: geocoding_attempt_type (primary, fallback, retry, manual_review, cache_hit).';
COMMENT ON COLUMN public.geocoding_attempts.status IS 'Execution status for provider attempt (queued, in_progress, succeeded, failed, skipped, deferred).';
-- =============================================================================
-- SECTION 5: Partitioning configuration entry
-- =============================================================================

INSERT INTO partitioning_config (
    table_name,
    partition_strategy,
    partition_key,
    partition_interval,
    partitions_ahead,
    retention_months,
    config
)
VALUES (
    'geocoding_attempts',
    'HASH',
    'address_id',
    NULL,
    NULL,
    NULL,
    '{"modulus": 4, "expandable_to": [8, 16]}'::jsonb
)
ON CONFLICT (table_name) DO UPDATE
SET
    partition_strategy = EXCLUDED.partition_strategy,
    partition_key = EXCLUDED.partition_key,
    partition_interval = EXCLUDED.partition_interval,
    partitions_ahead = EXCLUDED.partitions_ahead,
    retention_months = EXCLUDED.retention_months,
    config = EXCLUDED.config;

COMMIT;
