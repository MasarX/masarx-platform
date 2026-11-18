-- Give legacy Console V2 resources the columns used by their existing screens.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Shape only the JSON fields selected by the screen contract.
CREATE FUNCTION public.console_v2_project_json_v1(p_value JSONB, p_shape JSONB)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp
AS $shape$
BEGIN
  IF p_shape = '"displayed"'::jsonb THEN
    RETURN p_value;
  ELSIF p_shape = '"operator_sample"'::jsonb THEN
    CASE jsonb_typeof(p_value)
      WHEN 'object' THEN
        RETURN (
          SELECT COALESCE(jsonb_object_agg(field.key,
            CASE
              WHEN field.key ~* '^(authorization|proxy-authorization|cookie|set-cookie)$'
                OR field.key ~* '(^|[_-])(token|secret|signature|hmac|password|credential|api[-_]?key|access[_-]?key|private[_-]?key)([_-]|$)'
              THEN to_jsonb('[redacted]'::text)
              ELSE public.console_v2_project_json_v1(field.value, p_shape)
            END), '{}'::jsonb)
          FROM jsonb_each(p_value) field
        );
      WHEN 'array' THEN
        RETURN (
          SELECT COALESCE(jsonb_agg(public.console_v2_project_json_v1(item.value, p_shape)
            ORDER BY item.ordinal), '[]'::jsonb)
          FROM jsonb_array_elements(p_value) WITH ORDINALITY item(value, ordinal)
        );
      WHEN 'string' THEN
        RETURN to_jsonb(public.redact_sensitive_text_v1(p_value #>> '{}'));
      ELSE
        RETURN p_value;
    END CASE;
  ELSIF p_shape = 'true'::jsonb THEN
    IF jsonb_typeof(p_value) IN ('boolean', 'number', 'string') THEN
      RETURN p_value;
    END IF;
  ELSIF jsonb_typeof(p_shape) = 'object' AND jsonb_typeof(p_value) = 'object' THEN
    RETURN (
      SELECT jsonb_object_agg(field.key, filtered.value)
      FROM jsonb_each(p_shape) field
      CROSS JOIN LATERAL public.console_v2_project_json_v1(p_value->field.key, field.value) filtered(value)
      WHERE filtered.value IS NOT NULL
    );
  ELSIF jsonb_typeof(p_shape) = 'array' AND jsonb_typeof(p_value) = 'array' THEN
    RETURN (
      SELECT COALESCE(jsonb_agg(filtered.value ORDER BY item.ordinal), '[]'::jsonb)
      FROM jsonb_array_elements(p_value) WITH ORDINALITY item(value, ordinal)
      CROSS JOIN LATERAL public.console_v2_project_json_v1(item.value, p_shape->0) filtered(value)
      WHERE filtered.value IS NOT NULL
    );
  END IF;
  RETURN NULL;
END;
$shape$;

REVOKE ALL ON FUNCTION public.console_v2_project_json_v1(JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;

DO $registry$
DECLARE
  v_row RECORD;
  v_resource JSONB;
  v_resources JSONB;
  v_next JSONB;
  v_key TEXT;
  v_selection JSONB;
  v_relation REGCLASS;
  v_reviewed_json_resources CONSTANT TEXT[] := ARRAY[
    'alert_triggers', 'bank_recon_matches', 'billing_invoice_events', 'billing_invoice_lines',
    'billing_invoices', 'branches', 'cod_entries', 'commercial_agreement_terms',
    'commercial_agreements', 'driver_application_directory', 'driver_compliance_events', 'driver_directory',
    'finance_events_ledger', 'geocoding_attempts', 'lookup_values', 'mapping_config_directory', 'marketplace_disputes',
    'provider_health_logs', 'rbac_roles', 'recent_workflow_events', 'route_plan_directory', 'route_run_assignments',
    'route_run_directory', 'route_runs', 'service_levels', 'service_offering_directory',
    'service_offerings', 'settlement_batch_summary', 'settlement_batches', 'subscriptions',
    'support_case_events', 'support_cases', 'task_events', 'usage_events', 'user_device_summary',
    'vehicle_documents', 'vehicle_events', 'webhook_inbox_directory', 'zone_override_requests'
  ];
  v_json_names CONSTANT TEXT[] := ARRAY[
    'metadata','payload','partner','partner_payload','response_metadata',
    'managed_metadata','mapping_config','raw_payload','transformed_payload'
  ];
  v_whole_json CONSTANT JSONB := '{
    "alert_triggers": ["payload"],
    "billing_invoice_events": ["payload"],
    "driver_compliance_events": ["payload"],
    "lookup_values": ["metadata"],
    "recent_workflow_events": ["payload"],
    "support_case_events": ["payload"],
    "vehicle_events": ["metadata"]
  }'::jsonb;
  v_shaped_json CONSTANT JSONB := '{
    "billing_invoice_lines": {
      "sql": "CREATE VIEW public.console_billing_invoice_lines_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_billing_invoice_lines_read_v1",
      "columns": {"metadata":{"source_event_ids":[true]}},
      "revoke": "REVOKE ALL ON public.console_billing_invoice_lines_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "billing_invoices": {
      "sql": "CREATE VIEW public.console_billing_invoices_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_billing_invoices_read_v1",
      "columns": {"metadata":{"subscription_id":true}},
      "revoke": "REVOKE ALL ON public.console_billing_invoices_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "branches": {
      "sql": "CREATE VIEW public.console_branches_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_branches_read_v1",
      "columns": {"metadata":{"lifecycle":true,"initial_capacity_per_day":true}},
      "revoke": "REVOKE ALL ON public.console_branches_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "cod_entries": {
      "sql": "CREATE VIEW public.console_cod_entries_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_cod_entries_read_v1",
      "columns": {"metadata":{"tracking":true,"expected":true,"collected":true,"remitted":true,"status":true,"driver":true,"discrepancy":true,"settlement_context_ready":true,"branch_id":true,"driver_user_id":true}},
      "revoke": "REVOKE ALL ON public.console_cod_entries_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "commercial_agreement_terms": {
      "sql": "CREATE VIEW public.console_commercial_agreement_terms_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_commercial_agreement_terms_read_v1",
      "columns": {"metadata":{"value":true}},
      "revoke": "REVOKE ALL ON public.console_commercial_agreement_terms_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "commercial_agreements": {
      "sql": "CREATE VIEW public.console_commercial_agreements_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_commercial_agreements_read_v1",
      "columns": {"metadata":{"terms":true}},
      "revoke": "REVOKE ALL ON public.console_commercial_agreements_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "finance_events_ledger": {
      "sql": "CREATE VIEW public.console_finance_events_ledger_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_finance_events_ledger_read_v1",
      "columns": {"metadata":{"batch_id":true,"reverses_finance_event_id":true}},
      "revoke": "REVOKE ALL ON public.console_finance_events_ledger_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "geocoding_attempts": {
      "sql": "CREATE VIEW public.console_geocoding_attempts_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_geocoding_attempts_read_v1",
      "columns": {"metadata":{"attempt_type":true,"workflow_run_id":true,"geocoding_workflow_run_id":true,"address_resolution_workflow_run_id":true,"manual_review_task_id":true,"review_task_id":true,"task_id":true,"geocode_failure_reason":true,"failure_reason":true,"failure_code":true,"error":true,"message":true,"geocode_workflow_run_id":true,"nested_workflow_run_id":true}},
      "revoke": "REVOKE ALL ON public.console_geocoding_attempts_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "mapping_config_directory": {
      "sql": "CREATE VIEW public.console_mapping_config_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_mapping_config_read_v1",
      "columns": {"mapping_config":{"enabled":true,"label":true,"name":true,"target":true},"managed_metadata":{"plugin_version_id":true}},
      "revoke": "REVOKE ALL ON public.console_mapping_config_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "marketplace_disputes": {
      "sql": "CREATE VIEW public.console_marketplace_disputes_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_marketplace_disputes_read_v1",
      "columns": {"metadata":{"shipment_ref":true,"amount_sar":true}},
      "revoke": "REVOKE ALL ON public.console_marketplace_disputes_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "provider_health_logs": {
      "sql": "CREATE VIEW public.console_provider_health_logs_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_provider_health_logs_read_v1",
      "columns": {"metadata":{"latency_ms":true}},
      "revoke": "REVOKE ALL ON public.console_provider_health_logs_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "route_plan_directory": {
      "sql": "CREATE VIEW public.console_route_plan_directory_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_route_plan_directory_read_v1",
      "columns": {"metadata":{"organization_id":true,"wave_label":true,"wave_promise_at":true}},
      "revoke": "REVOKE ALL ON public.console_route_plan_directory_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "route_run_assignments": {
      "sql": "CREATE VIEW public.console_route_run_assignments_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_route_run_assignments_read_v1",
      "columns": {"partner":{"partner_id":true,"partner_name":true}},
      "revoke": "REVOKE ALL ON public.console_route_run_assignments_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "route_run_directory": {
      "sql": "CREATE VIEW public.console_route_run_directory_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_route_run_directory_read_v1",
      "columns": {"metadata":{"plan_id":true,"organization_id":true,"route_departure":{"confirmed_at":true},"alternate_capacity":{"marketplace_request_id":true,"demand_class":true}},"partner_payload":{"partner_id":true,"partner_name":true}},
      "revoke": "REVOKE ALL ON public.console_route_run_directory_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "route_runs": {
      "sql": "CREATE VIEW public.console_route_runs_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_route_runs_read_v1",
      "columns": {"metadata":{"plan_id":true,"organization_id":true,"route_departure":{"confirmed_at":true},"alternate_capacity":{"marketplace_request_id":true,"demand_class":true}}},
      "revoke": "REVOKE ALL ON public.console_route_runs_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "service_levels": {
      "sql": "CREATE VIEW public.console_service_levels_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_service_levels_read_v1",
      "columns": {"metadata":{"tier":true,"priority_rank":true,"sla_minutes":true,"sla_label":true,"color_token":true,"tone":true}},
      "revoke": "REVOKE ALL ON public.console_service_levels_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "service_offering_directory": {
      "sql": "CREATE VIEW public.console_service_offering_directory_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_service_offering_directory_read_v1",
      "columns": {"metadata":{"base_price":true,"currency":true,"max_weight_kg":true,"coverage_summary":true,"display":{"name":true,"slug":true,"status":true},"included_features":[true],"pricing_breakpoints":[{"up_to_kg":true,"price":true}]}},
      "revoke": "REVOKE ALL ON public.console_service_offering_directory_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "service_offerings": {
      "sql": "CREATE VIEW public.console_service_offerings_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_service_offerings_read_v1",
      "columns": {"metadata":{"base_price":true,"currency":true,"max_weight_kg":true,"coverage_summary":true,"display":{"name":true,"slug":true,"status":true},"included_features":[true],"pricing_breakpoints":[{"up_to_kg":true,"price":true}]}},
      "revoke": "REVOKE ALL ON public.console_service_offerings_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "settlement_batch_summary": {
      "sql": "CREATE VIEW public.console_settlement_batch_summary_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_settlement_batch_summary_read_v1",
      "columns": {"metadata":{"cod_entry_id":true}},
      "revoke": "REVOKE ALL ON public.console_settlement_batch_summary_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "settlement_batches": {
      "sql": "CREATE VIEW public.console_settlement_batches_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_settlement_batches_read_v1",
      "columns": {"metadata":{"cod_entry_id":true}},
      "revoke": "REVOKE ALL ON public.console_settlement_batches_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "subscriptions": {
      "sql": "CREATE VIEW public.console_subscriptions_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_subscriptions_read_v1",
      "columns": {"metadata":{"service_offering_id":true,"billing_period":true,"plan_label":true}},
      "revoke": "REVOKE ALL ON public.console_subscriptions_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "support_cases": {
      "sql": "CREATE VIEW public.console_support_cases_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_support_cases_read_v1",
      "columns": {"metadata":{"request_source":true,"request_type_key":true,"request_outcome":true,"requester_channel":true,"tracking_number":true,"change_summary":true,"changed_fields":"displayed","before_snapshot":"displayed","requested_snapshot":"displayed","current_snapshot":"displayed","shipment_status_snapshot":"displayed","review_task":{"task_id":true}}},
      "revoke": "REVOKE ALL ON public.console_support_cases_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "task_events": {
      "sql": "CREATE VIEW public.console_task_events_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_task_events_read_v1",
      "columns": {"payload":{"amount":true,"currency":true,"receipt_context":true,"deposit_slip_ref":true}},
      "revoke": "REVOKE ALL ON public.console_task_events_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    },
    "webhook_inbox_directory": {
      "sql": "CREATE VIEW public.console_webhook_inbox_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
      "name": "public.console_webhook_inbox_read_v1",
      "columns": {"raw_payload":"operator_sample"},
      "revoke": "REVOKE ALL ON public.console_webhook_inbox_read_v1 FROM PUBLIC, anon, authenticated, service_role"
    }
  }'::jsonb;
  v_source REGCLASS;
  v_source_name TEXT;
  v_view_config JSONB;
  v_scoped_views CONSTANT JSONB := '{
    "service_offering_directory": {
      "api.service_offering_directory": {
        "sql": "CREATE VIEW public.console_service_offering_api_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
        "name": "public.console_service_offering_api_read_v1",
        "revoke": "REVOKE ALL ON public.console_service_offering_api_read_v1 FROM PUBLIC, anon, authenticated, service_role"
      }
    },
    "route_runs": {
      "api.route_runs": {
        "sql": "CREATE VIEW public.console_route_runs_api_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
        "name": "public.console_route_runs_api_read_v1",
        "revoke": "REVOKE ALL ON public.console_route_runs_api_read_v1 FROM PUBLIC, anon, authenticated, service_role"
      },
      "public.command_route_runs_dashboard_v1": {
        "sql": "CREATE VIEW public.console_route_runs_dashboard_read_v1 WITH (security_invoker = true) AS SELECT %s FROM %s",
        "name": "public.console_route_runs_dashboard_read_v1",
        "revoke": "REVOKE ALL ON public.console_route_runs_dashboard_read_v1 FROM PUBLIC, anon, authenticated, service_role"
      }
    }
  }'::jsonb;
  v_view_name TEXT;
  v_view_sources JSONB := '{}'::jsonb;
  v_shape JSONB;
  v_keep_json JSONB;
  v_view_columns TEXT;
  v_missing TEXT[] := '{}';
  v_dev_additions CONSTANT TEXT[] := ARRAY['shipments','schema_registry','operation_handlers','workflow_template_steps','workflow_templates','webhook_source_directory','api_gateway_auth_rejections','webhook_auth_rejections','webhook_sources','workflow_run_triggers','workflow_schedule_triggers','workflow_trigger_fires','workflow_run_steps','workflow_runs'];
  v_columns CONSTANT JSONB := '{
    "alert_rule_directory": ["alert_channels", "condition_summary", "created_at", "created_by", "enabled", "is_throttled", "last_triggered_at", "organization_id", "rule_name", "severity_label", "trigger_conditions", "trigger_count_24h"],
    "alert_rules": ["alert_channels", "channel", "condition", "created_at", "created_by", "enabled", "name", "organization_id", "rule_name", "severity", "trigger_conditions"],
    "alert_triggers": ["fired_at", "payload", "rule_id", "status"],
    "api_gateway_observability": ["duration_ms", "error_code", "has_request_headers", "method", "occurred_at", "path", "request_id", "response_size_bytes", "route_id", "route_pack_id", "source_id", "source_label", "source_org_id", "status_code"],
    "api_gateway_rate_limits_summary": ["current_usage", "limit_per_hour", "limit_per_min", "request_count", "saturated", "source_id", "source_label", "window_start"],
    "auth_email_url_policy": ["audit_status", "callback_urls", "env", "last_audit_at", "redirect_urls", "source_file"],
    "bank_accounts": ["account_last4", "bank_name", "created_at", "currency", "iban_last4", "id", "is_active", "key", "name", "organization_id"],
    "bank_recon_matches": ["bank_statement_event_id", "created_at", "currency", "id", "matched_amount", "resource_id", "resource_type", "status"],
    "billing_invoice_directory": ["amount_due", "amount_paid", "client_id", "client_label", "created_at", "currency", "id", "invoice_id", "invoice_number", "is_overdue", "organization_id", "payment_status", "sent_at", "status", "total", "total_amount"],
    "billing_invoice_events": ["actor_user_id", "created_at", "event_type", "id", "invoice_id", "occurred_at", "payload"],
    "billing_invoice_lines": ["created_at", "description", "id", "invoice_id", "line_total", "metadata", "qty", "unit_price"],
    "billing_invoices": ["client_id", "client_label", "created_at", "currency", "due_date", "id", "invoice_number", "metadata", "organization_id", "paid_at", "period_end", "period_start", "sent_at", "status", "subscription_id", "total_amount"],
    "branch_capacity_heatmap": ["booked_units", "branch_id", "capacity_units", "hour", "id", "source_window_id", "weekday", "zone_id"],
    "branch_coverage_windows": ["branch_id", "close_at", "effective_from", "effective_to", "id", "is_active", "open_at", "priority", "reason", "zone_id"],
    "branch_memberships": ["branch_id", "created_at", "effective_from", "effective_to", "id", "is_active", "joined_at", "role", "role_key", "user_id"],
    "branch_summary": ["active_routes", "active_vehicles", "booked_today", "branch_id", "branch_type", "capacity_per_day", "code", "cutoff_time", "is_active", "lat", "latitude", "lng", "longitude", "name", "organization_id", "timezone", "updated_at"],
    "branch_zone_directory": ["branch_id", "branch_label", "branch_type", "created_at", "hub_code", "id", "organization_id", "priority", "zone_id"],
    "branch_zones": ["branch_id", "created_at", "id", "organization_id", "priority", "zone_id"],
    "branches": ["address", "branch_type", "city", "code", "coordinates", "created_at", "id", "is_active", "lat", "lng", "metadata", "name", "operating_hours", "organization_id", "status", "timezone", "updated_at"],
    "canonical_cities": ["city_code", "code", "country", "country_code", "id", "name", "name_arabic", "name_canonical", "name_en"],
    "canonical_districts": ["centroid_lat", "centroid_lng", "city_code", "city_id", "city_label", "city_name", "code", "id", "name", "name_ar", "name_arabic", "name_canonical", "name_en"],
    "capability_grant_requests": ["capability_key","created_at","decided_at","decision_notes","id","organization_id","reason","requested_by","requested_by_email","requested_by_full_name","scope_id","scope_type","status","target_user_email","target_user_full_name","target_user_id"],
    "cod_entries": ["amount", "collected_at", "created_at", "currency", "id", "metadata", "organization_id", "shipment_id", "subject_id"],
    "commercial_agreement_terms": ["agreement_id", "category", "metadata"],
    "commercial_agreements": ["agreement_code", "client_id", "expires_at", "metadata", "signed_at", "status", "title"],
    "decision_log_directory": ["age_seconds","decision_category","has_correlation","has_resolution","id","organization_id","resolved_from","resource_id","resource_type","scope_category","settings_resolution_id","timestamp","winning_settings_id","winning_version"],
    "dispute_directory": ["amount_sar", "counterparty_label", "counterparty_organization_id", "dispute_id", "escalation_at", "escalation_count", "is_escalated", "is_terminal", "opened_by_label", "opened_by_organization_id", "opened_by_user_label", "resolved_by_user_label", "shipment_ref"],
    "driver_application_directory": ["approved_organization_id", "approved_participant_profile_id", "approved_user_id", "capabilities_count", "capabilities_requested", "created_at", "decision_age_seconds", "decision_metadata", "dedupe_hint", "driver_profile_id", "email", "experience_summary", "fleet_compliance_event_count", "fleet_document_count", "fleet_driver_status", "fleet_handoff_ready", "fleet_last_compliance_event_at", "full_name", "intake_source", "invite_email_sent_at", "invite_redirect_to", "ip_country", "is_approved", "is_pending", "is_rejected", "is_terminal", "is_withdrawn", "locale", "missing_document_count", "organization_name", "organization_slug", "origin", "page_url", "phone", "referrer", "review_decision", "review_reason", "reviewed_at", "reviewed_by", "reviewer_email", "reviewer_label", "sla_breach", "status", "submitted_document_count", "turnstile_verified", "updated_at", "utm_campaign", "utm_source", "verification_documents", "verification_documents_count", "website_url"],
    "driver_compliance_events": ["actor", "actor_system", "actor_user_id", "created_at", "driver_id", "event_type", "id", "occurred_at", "payload", "severity", "user_id"],
    "driver_directory": ["branch_label", "compliance_event_count", "compliance_event_count_24h", "compliance_score", "created_at", "critical_compliance_count", "current_branch_id", "current_vehicle_id", "customer_rating", "deliveries_today", "deliveries_week", "document_count", "driver_code", "earliest_document_expiry", "emergency_contact_name", "emergency_contact_phone", "expired_document_count", "expiring_document_count", "has_expired_documents", "has_expiring_documents", "hired_at", "hos_active_duty_status", "hos_active_segment_id", "hos_segment_count", "hos_segment_count_24h", "hours_of_service_state", "id", "is_active", "is_inactive", "is_suspended", "last_active_at", "license_class", "license_expires_at", "license_number", "name", "on_time_pct", "organization_id", "phone", "status", "tenure_seconds", "user_email", "user_full_name", "user_id", "vehicle_label", "vehicle_plate"],
    "driver_documents": ["artifact_id", "doc_type", "driver_id", "expires_at", "file_ref", "id", "issued_at", "issuer", "kind", "status", "user_id", "verified_at"],
    "drivers": ["created_at", "driver_code", "id", "is_active", "name", "organization_id", "phone", "status", "user_email", "user_full_name", "user_id", "vehicle_id"],
    "finance_events_bank_statement": ["account_id", "account_type", "amount", "attached", "bank_account_key", "currency", "description", "direction", "event_type", "id", "occurred_at", "organization_id"],
    "finance_events_ledger": ["account", "account_id", "amount", "batch_id", "credit", "currency", "debit", "direction", "event_type", "id", "metadata", "occurred_at", "organization_id", "settlement_batch_id"],
    "fleet_user_options": ["email", "full_name", "organization_id", "status"],
    "geocodes": ["accuracy_type", "address_id", "cached_at", "confidence", "confidence_score", "created_at", "geocoded_at", "id", "is_primary", "lat", "latitude", "lng", "longitude", "provider", "provider_name"],
    "geocoding_attempts": ["address_id", "attempt_type", "confidence", "confidence_score", "created_at", "decision_outcome", "duration_ms", "id", "metadata", "provider", "provider_name", "status", "updated_at"],
    "hubs": ["branch_type", "city", "code", "coordinates", "cutoff_time", "id", "lat", "latitude", "lng", "longitude", "name", "organization_id"],
    "kpi_definitions": ["definition", "is_active", "key"],
    "lookup_values": ["category", "effective_from", "effective_until", "id", "is_default", "label", "lookup_definition_id", "metadata", "rank", "sort_order", "status", "tone", "value"],
    "mapping_config_directory": ["api_route_count", "has_rules", "id", "is_in_use", "managed_by", "managed_metadata", "mapping_config", "mapping_key", "mapping_type", "mapping_version", "organization_id", "rule_usage_count", "rules_count", "source_count", "target", "updated_at"],
    "marketing_intake_metrics_24h": ["dedupe_dropped", "id", "rate_limited", "total", "turnstile_failed", "verified"],
    "marketing_intake_recent": ["company", "decision", "dedupe_status", "dispatch_id", "email", "id", "ip_hash", "rate_limit_status", "received_at", "role", "source", "task_id", "turnstile_status", "workflow_run_id"],
    "marketplace_disputes": ["category", "contract_id", "counterparty_organization_id", "created_at", "filed_at", "id", "kind", "metadata", "opened_by_organization_id", "resolution", "status", "title"],
    "ops_sessions": ["actor_user_id", "closed_at", "id", "idempotency_key", "opened_at", "organization_id", "session_type", "status"],
    "planning_os_execution_cards": [],
    "planning_os_project_items": [],
    "provider_auth_configs": ["auth_type", "days_until_expiry", "expires_at", "id", "last_rotated_at", "organization_id", "provider_id", "provider_label", "status"],
    "provider_health_logs": ["created_at", "error_message", "metadata", "occurred_at", "provider_id", "status"],
    "rbac_role_permissions": ["created_at", "granted_at", "granted_by_user_id", "organization_id", "permission_id", "permission_value", "role_id", "updated_at"],
    "rbac_role_summary": ["active_assignment_count", "assignment_count", "created_at", "description", "is_active", "key", "last_assigned_at", "name", "organization_id", "organization_label", "permission_count", "permission_values", "revoked_assignment_count", "role_tier", "updated_at"],
    "rbac_role_templates": ["created_at", "description", "is_active", "key", "name", "permission_count", "permission_values", "updated_at"],
    "rbac_roles": ["assignment_count", "description", "id", "is_active", "key", "name", "organization_id", "permission_count", "updated_at"],
    "rbac_user_role_assignments": ["assigned_at", "assigned_by_user_id", "created_at", "organization_id", "revoked_at", "revoked_by_user_id", "role_id", "role_key", "role_name", "updated_at", "user_email", "user_full_name", "user_id"],
    "recent_workflow_events": ["event", "matched_template", "payload", "received_at"],
    "route_plan_directory": ["applied_at", "branch_code", "branch_id", "branch_label", "drivers_notified_count", "id", "is_applied", "metadata", "organization_id", "plan_display_id", "planned_date", "run_count", "status", "stop_count", "updated_at", "wave_label"],
    "route_run_assignment_events": ["assignment_mode", "assignment_version", "created_at", "event_type", "from_status", "notes", "route_run_id", "to_status"],
    "route_run_assignments": ["accepted_at", "acknowledged_at", "assignment_mode", "assignment_status", "assignment_version", "driver_user_id", "partner", "refusal_reason", "refused_at", "response_notes", "route_run_id", "vehicle_id"],
    "route_run_directory": ["assignment_driver_user_id", "assignment_mode", "assignment_status", "assignment_vehicle_id", "assignment_version", "branch_id", "branch_label", "cod_total", "created_at", "driver_label", "driver_user_id", "is_partner_run", "metadata", "organization_id", "partner_name", "partner_payload", "planned_date", "planned_start_at", "run_display_id", "status", "stop_count", "vehicle_id", "vehicle_label"],
    "route_runs": ["branch_id", "completed", "created_at", "driver", "driver_user_id", "id", "metadata", "organization_id", "plan_id", "planned_date", "planned_start_at", "route_plan_id", "run_id", "status", "stops", "vehicle", "vehicle_id"],
    "route_stop_reassignment_events": ["created_at", "event_type", "notes", "route_stop_id", "shipment_id", "source_route_run_id", "target_route_run_id"],
    "service_levels": ["created_at", "id", "is_active", "key", "metadata", "name", "organization_id"],
    "service_offering_directory": ["active_subscription_count", "billing_model", "branch_id", "branch_label", "client_id", "is_active", "key", "level_is_active", "level_key", "level_name", "metadata", "name", "organization_id", "plan_key", "pricing_strategy", "sender_id", "service_level_id", "service_scope", "subscription_count", "tenant_label", "updated_at", "zone_id", "zone_label"],
    "service_offerings": ["branch_id", "created_at", "id", "is_active", "metadata", "organization_id", "service_level_id", "zone_id"],
    "settlement_batch_summary": ["collected_amount", "created_at", "currency", "expected_amount", "id", "kind", "metadata", "organization_id", "posted_at", "remitted_amount", "scope", "scope_type", "status", "updated_at", "variance_flag"],
    "settlement_batches": ["collected_amount", "created_at", "currency", "expected_amount", "id", "kind", "metadata", "organization_id", "posted_at", "remitted_amount", "scope_type", "status", "status_reason", "updated_at", "variance_flag"],
    "shipment_directory": ["active_task_count", "box_actual_count", "carrier_reference_number", "client_id", "client_label", "client_reference_number", "comms_attempt_count", "created_at", "destination_city", "id", "label_count", "last_scan_at", "organization_id", "promised_delivery_date", "recipient_id", "recipient_label", "scan_event_count", "sender_id", "sender_label", "service_type", "shipment_display_id", "status", "tracking_number"],
    "subscriptions": ["base_fee_sar", "client_id", "created_at", "ended_at", "id", "metadata", "plan_key", "sender_id", "started_at", "status", "status_reason"],
    "support_case_directory": ["assignee_label", "client_label", "is_open", "is_terminal", "last_message_at", "message_count", "recipient_id", "recipient_label", "recipient_phone", "related_shipment_id", "resolution_label", "sender_label", "shipment_tracking_number", "sla_breached"],
    "support_case_events": ["actor_user_id", "created_at", "event_type", "from_status", "payload", "support_case_id", "to_status"],
    "support_cases": ["assigned_to", "change_summary", "changed_fields", "channel", "client_id", "closed_at", "last_message_at", "message_count", "metadata", "opened_at", "organization_id", "priority", "recipient_id", "related_shipment_id", "request_outcome", "request_source", "request_type_key", "requester_channel", "sender_id", "shipment_status_snapshot", "sla_breached", "sla_due_at", "status", "status_reason", "subject", "tags", "tracking_number"],
    "support_message_directory": ["author_label", "author_role", "author_user_id", "channel", "direction", "sent_at", "support_case_id"],
    "support_messages": ["attachments", "author_name", "author_role", "author_user_id", "body", "channel", "created_at", "direction", "sent_at", "support_case_id"],
    "support_users": ["name"],
    "task_events": ["actor", "actor_system", "actor_user_id", "created_at", "event", "event_type", "from_status", "notes", "occurred_at", "ops_session_id", "payload", "task_id", "to_status"],
    "tenant_signup_request_summary": ["approved_auth_user_id", "approved_organization_id", "approved_organization_label", "approved_user_email", "approved_user_id", "attestation_complete", "attestation_count", "attestation_passed_count", "created_at", "decision_age_seconds", "email", "full_name", "has_marketing_consent", "id", "invite_email_sent_at", "invite_redirect_to", "is_approved", "is_pending", "is_rejected", "last_error_at", "last_error_code", "last_error_message", "organization_name", "organization_slug", "review_decision", "reviewed_at", "reviewed_by", "reviewer_email", "reviewer_label", "status"],
    "ui_event_log": [],
    "ui_event_log_directory": ["has_resolution", "has_scope", "is_action"],
    "usage_events": ["client_id", "kind", "occurred_at", "qty"],
    "user_device_summary": ["app_version", "attestation_status", "attestation_trusted_at", "device_id", "device_label", "device_platform", "id", "is_revoked", "last_seen_at", "model", "organization_id", "os_version", "platform", "push_token_cleared", "revoked_at", "revoked_reason", "user_id"],
    "user_directory": ["access_scope_id", "access_scope_label", "access_scope_type", "active_role_count", "active_role_keys", "created_at", "email", "full_name", "last_login_at", "organization_id", "organization_label", "status", "user_id", "user_type"],
    "vehicle_assignments": ["assigned_to_user_id", "created_at", "driver_name", "driver_user_id", "ended_at", "id", "started_at", "status", "vehicle_id"],
    "vehicle_directory": ["active_assignment_branch_id", "active_assignment_started_at", "active_maintenance_count", "assignment_age_seconds", "branch_id", "branch_label", "code", "created_at", "current_branch_id", "current_branch_label", "current_driver_label", "current_driver_user_id", "event_count_24h", "fuel_level", "id", "is_in_maintenance", "is_oos", "last_event_at", "last_telemetry_at", "maintenance_due", "maintenance_window_count", "odometer_km", "organization_id", "plate", "plate_number", "status", "type_id", "type_name", "vehicle_type_id", "vehicle_type_label", "vin"],
    "vehicle_documents": ["artifact_id", "doc_type", "expires_at", "issued_at", "issuer", "kind", "organization_id", "status", "vehicle_id"],
    "vehicle_events": ["actor_name", "actor_user_id", "cost_amount", "cost_currency", "event_type", "fuel_liters", "metadata", "occurred_at", "odometer_km", "vehicle_id"],
    "vehicle_maintenance_directory": ["age_seconds", "duration_seconds", "is_cancelled", "is_completed", "is_in_progress", "is_overdue", "is_scheduled", "is_terminal", "planned_end", "planned_start", "reason", "scheduled_by_label", "scheduled_kind", "starts_in_seconds", "status", "vehicle_id", "vehicle_label", "vehicle_type_label", "window_end_at", "window_start_at"],
    "vehicle_types": ["axles", "capacity_kg", "capacity_m3", "fuel_type", "key", "kind", "max_speed_kph", "name"],
    "warehouse_transfer_summary": ["dispatched_at", "from_branch_id", "hold_reason", "id", "item_count", "organization_id", "posted_at", "received_at", "received_count", "status", "to_branch_id", "transfer_code", "updated_at", "variance_count", "variance_flag"],
    "wave_catalog": ["active", "id", "label", "sort_order"],
    "webhook_inbox_directory": ["ack_outcome", "ack_reason", "ack_status_code", "age_hours", "age_seconds", "canonical_intent", "correlation_id", "created_at", "error_message", "event_type", "external_id", "force_status_count", "id", "idempotency_key", "is_actionable", "is_terminal", "last_replay_action", "last_replay_actor", "last_replay_at", "mapping_config_id", "mapping_label", "mapping_rules_count", "mapping_target", "mapping_version", "organization_id", "payload_size", "processed_at", "processing_status", "provider_type_label", "raw_payload", "replay_count", "response_mode", "response_outcome", "response_reason", "response_status_code", "shipment_id", "shipment_status", "source_identifier", "source_label", "tracking_number", "webhook_source_id", "workflow_run_id", "workflow_run_status"],
    "webhook_rules": ["created_at", "domain_category", "enabled", "event_type", "mapping_config_id", "name", "priority", "webhook_source_id", "workflow_template_id"],
    "workflow_binding_directory": ["binding_key", "configurability_status", "default_template_name", "default_workflow_template_id", "is_active", "label"],
    "workflow_binding_dispatches": ["binding_key", "created_at", "event", "idempotency_key", "outcome", "resolved_scope_type", "stage_key", "template_name", "workflow_run_id", "workflow_template_id"],
    "workflow_bindings": ["condition", "event", "priority", "stage_key", "status", "template_id"],
    "zone_override_requests": ["created_at", "current_zone_id", "decided_by_user_id", "decision_at", "id", "requested_by", "requested_by_user_id", "requested_zone_id", "reviewed_at", "reviewed_by", "shipment_id", "status", "zone_id"],
    "zone_performance_metrics": ["zone_id"],
    "zone_summary": ["branch_count", "color_token", "created_at", "district_count", "geometry", "hub_code", "is_active", "name", "organization_id", "pending_overrides", "slug", "updated_at", "zone_id"]
  }
'::jsonb;
BEGIN
  FOR v_row IN
    SELECT s.scope_type, s.scope_id, sv.value, sv.schema_version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
     WHERE s.category = 'ui_read_registry'
     ORDER BY s.id
     FOR UPDATE OF s, sv
  LOOP
    v_resources := '[]'::jsonb;
    FOR v_resource IN SELECT value FROM jsonb_array_elements(v_row.value->'resources') LOOP
      v_key := v_resource->>'key';
      IF v_key = 'operation_handlers'
         AND v_resource->>'relation' = 'public.v_operation_handler_directory'
         AND v_resource->>'write_relation' = 'public.operation_handlers'
         AND NOT (v_resource ? 'read_relation') THEN
        v_resource := v_resource || jsonb_build_object(
          'relation', 'public.operation_handlers',
          'read_relation', 'public.v_operation_handler_directory'
        );
      END IF;
      IF NOT (v_resource ? 'select') OR v_resource->'select' = '[]'::jsonb THEN
        IF NOT COALESCE(v_key = ANY(v_dev_additions), FALSE) THEN
          IF NOT COALESCE(v_columns ? v_key, FALSE) THEN
            IF NOT (COALESCE(v_key, '<missing key>') = ANY(v_missing)) THEN
              v_missing := array_append(v_missing, COALESCE(v_key, '<missing key>'));
            END IF;
            CONTINUE;
          END IF;

          v_relation := to_regclass(v_resource->>'relation');
          SELECT jsonb_agg(to_jsonb(attname::text) ORDER BY attnum)
            INTO v_selection
            FROM pg_catalog.pg_attribute
           WHERE attrelid = v_relation AND attnum > 0 AND NOT attisdropped
             AND ((v_columns->v_key) ? attname::text
               OR attname::text = COALESCE(v_resource->>'id_column', 'id'));
          IF v_selection IS NULL THEN
            RAISE EXCEPTION 'Console V2 read projection has no matching fields for %', v_key;
          END IF;
          v_resource := jsonb_set(v_resource, '{select}', v_selection);
        END IF;
      END IF;

      IF v_key = ANY(v_reviewed_json_resources) THEN
        v_shape := v_shaped_json #> ARRAY[v_key, 'columns'];
        v_keep_json := COALESCE(v_whole_json->v_key, '[]'::jsonb);
        IF jsonb_typeof(v_resource->'select') = 'array' THEN
          SELECT COALESCE(jsonb_agg(field ORDER BY ordinal), '[]'::jsonb) INTO v_selection
          FROM jsonb_array_elements_text(v_resource->'select') WITH ORDINALITY AS fields(field, ordinal)
          WHERE field <> ALL(v_json_names) OR COALESCE(v_shape ? field, FALSE) OR v_keep_json ? field;
          v_resource := jsonb_set(v_resource, '{select}', v_selection);
        END IF;
        IF jsonb_typeof(v_resource->'columns') = 'array' THEN
          SELECT COALESCE(jsonb_agg(entry ORDER BY ordinal), '[]'::jsonb) INTO v_selection
          FROM jsonb_array_elements(v_resource->'columns') WITH ORDINALITY AS fields(entry, ordinal)
          WHERE entry->>'key' <> ALL(v_json_names)
             OR COALESCE(v_shape ? (entry->>'key'), FALSE) OR v_keep_json ? (entry->>'key');
          v_resource := jsonb_set(v_resource, '{columns}', v_selection);
        END IF;

        -- Keep the mutation relation and apply the same scope predicates through an invoker read view.
        IF v_shape IS NOT NULL THEN
          v_source := to_regclass(COALESCE(NULLIF(v_resource->>'read_relation', ''), v_resource->>'relation'));
          SELECT n.nspname || '.' || c.relname INTO v_source_name
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.oid = v_source AND (
            (n.nspname = 'public' AND c.relkind IN ('p','r','v'))
            OR (n.nspname = 'api' AND c.relkind = 'v'
                AND COALESCE(v_scoped_views->v_key ? (n.nspname || '.' || c.relname), FALSE)
                AND EXISTS (
                  SELECT 1 FROM pg_options_to_table(c.reloptions) opt
                  WHERE opt.option_name = 'security_invoker' AND opt.option_value::boolean
                ))
          );
          IF v_source_name IS NULL THEN
            RAISE EXCEPTION 'Console V2 read projection has an unsupported source for %', v_key;
          END IF;
          v_view_config := COALESCE(v_scoped_views #> ARRAY[v_key, v_source_name], v_shaped_json->v_key);
          v_view_name := v_view_config->>'name';
          IF v_view_sources ? v_view_name THEN
            IF v_view_sources->>v_view_name <> v_source::oid::text THEN
              RAISE EXCEPTION 'Console V2 read projection has different scope sources for %', v_key;
            END IF;
          ELSE
            SELECT string_agg(
              CASE WHEN v_shape ? a.attname::text THEN
                format('public.console_v2_project_json_v1(%I::jsonb, %L::jsonb) AS %I',
                  a.attname, v_shape->(a.attname::text), a.attname)
              ELSE quote_ident(a.attname) END, ', ' ORDER BY a.attnum
            ) INTO v_view_columns
            FROM pg_attribute a
            WHERE a.attrelid = v_source AND a.attnum > 0 AND NOT a.attisdropped;
            EXECUTE format(v_view_config->>'sql', v_view_columns, v_source);
            EXECUTE v_view_config->>'revoke';
            v_view_sources := jsonb_set(v_view_sources, ARRAY[v_view_name], to_jsonb(v_source::oid::text));
          END IF;
          v_resource := jsonb_set(v_resource, '{read_relation}', to_jsonb(v_view_name));
        END IF;
      END IF;
      v_resources := v_resources || jsonb_build_array(v_resource);
    END LOOP;
    v_next := jsonb_set(v_row.value, '{resources}', v_resources);
    IF v_next IS DISTINCT FROM v_row.value THEN
      PERFORM public.upsert_settings_value_v1(
        'ui_read_registry', v_row.scope_type, v_row.scope_id, v_next, v_row.schema_version,
        'Declare explicit Console V2 read projections');
    END IF;
  END LOOP;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'Console V2 read projection requires a declared field list: %', array_to_string(v_missing, ', ');
  END IF;
END;
$registry$;

DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';
COMMIT;
