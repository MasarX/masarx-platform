-- Migration: send_comms_reply single-match scope guard
-- Purpose: Ensure shipment lookups are scoped by organization+client even when a single match is detected.
-- Date: 2025-12-14

BEGIN;

CREATE OR REPLACE FUNCTION public.send_comms_reply(
    p_webhook_id UUID,
    p_webhook_source_id UUID,
    p_comm JSONB,
    p_organization_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_policy_row RECORD;
    v_policy JSONB := '{}'::jsonb;
    v_intents JSONB := '{}'::jsonb;
    v_match_text TEXT;
    v_policy_scope_type TEXT;
    v_policy_scope_id UUID;
    v_policy_settings_id UUID;
    v_policy_settings_version_id UUID;
    v_policy_version INT;
    v_scope_path JSONB := '[]'::jsonb;
    v_settings_resolution_id UUID;

    v_reply_text TEXT := lower(COALESCE(p_comm->>'reply_text', ''));
    v_reply_payload TEXT := lower(COALESCE(p_comm->>'reply_payload', ''));
    v_recipient_raw TEXT := NULLIF(p_comm->>'recipient', '');
    v_recipient TEXT := public.normalize_phone_number(v_recipient_raw);
    v_message_id TEXT := NULLIF(p_comm->>'message_id', '');

    v_intent TEXT := 'fallback';
    v_intent_cfg JSONB := '{}'::jsonb;
    v_template TEXT;
    v_not_found_template TEXT;
    v_requires_shipment BOOLEAN := FALSE;
    v_stop_workflow BOOLEAN := FALSE;
    v_opt_out BOOLEAN := FALSE;
    v_allow_opted_out_send BOOLEAN := FALSE;

    v_message TEXT;
    v_eta TEXT;
    v_tracking TEXT;
    v_status TEXT;
    v_shipment RECORD;
    v_shipment_id UUID := NULL;
    v_lookup_reason TEXT := NULL;

    v_sender_id UUID := NULL;
    v_client_id UUID := NULL;
    v_auth_config_id UUID := NULL;

    v_recipient_id UUID := NULL;
    v_is_opted_out BOOLEAN := FALSE;
    v_inbound_at TIMESTAMPTZ := NULL;

    v_dry_run BOOLEAN := FALSE;
    v_outbound_call_id UUID := NULL;
    v_queued BOOLEAN := FALSE;
    v_error TEXT := NULL;
    v_decision_inputs JSONB;
    v_corr UUID := NULL;
    v_render_context JSONB;

    -- Disambiguation session
    v_session RECORD;
    v_session_id UUID := NULL;
    v_session_shipments JSONB := '[]'::jsonb;
    v_selection_raw TEXT := NULL;
    v_selection_norm TEXT := NULL;
    v_selected JSONB := NULL;
    v_selected_shipment_id UUID := NULL;
    v_multi_cfg JSONB := '{}'::jsonb;
    v_multi_template TEXT := NULL;
    v_multi_invalid_template TEXT := NULL;
    v_multi_ttl_seconds INT := NULL;
    v_multi_max_options INT := NULL;
    v_options_text TEXT := NULL;
    v_match_n INT := 0;
    v_has_more BOOLEAN := FALSE;

    -- Rate limit
    v_rate_cfg JSONB := '{}'::jsonb;
    v_rate_enabled BOOLEAN := FALSE;
    v_rate_window_seconds INT := NULL;
    v_rate_max_replies INT := NULL;
    v_rate_result JSONB := NULL;
BEGIN
    -- Resolve sender/client context from webhook source (prevents cross-client leakage within org).
    SELECT ws.sender_id, s.client_id
      INTO v_sender_id, v_client_id
      FROM public.webhook_sources ws
      LEFT JOIN public.senders s ON s.id = ws.sender_id
     WHERE ws.id = p_webhook_source_id;

    -- Resolve comms_reply_policy via full ladder starting at source scope.
    SELECT *
      INTO v_policy_row
      FROM public.resolve_settings_row('comms_reply_policy', 'source', p_webhook_source_id)
      LIMIT 1;

    IF NOT FOUND OR v_policy_row.value IS NULL THEN
        RETURN jsonb_build_object('status', 'skipped', 'reason', 'policy_missing');
    END IF;

    v_policy := v_policy_row.value;
    v_policy_scope_type := v_policy_row.scope_type;
    v_policy_scope_id := v_policy_row.scope_id;
    v_policy_settings_id := v_policy_row.settings_id;
    v_policy_settings_version_id := v_policy_row.settings_version_id;
    v_policy_version := v_policy_row.version;
    v_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb);

    v_auth_config_id := NULLIF(v_policy->>'auth_config_id', '')::UUID;
    v_intents := COALESCE(v_policy->'intents', '{}'::jsonb);
    v_dry_run := COALESCE((v_policy->>'dry_run')::BOOLEAN, FALSE);

    v_settings_resolution_id := public.log_settings_resolution(
        p_organization_id := p_organization_id,
        p_category := 'comms_reply_policy',
        p_winning_scope_type := v_policy_scope_type,
        p_winning_scope_id := v_policy_scope_id,
        p_winning_settings_id := v_policy_settings_id,
        p_winning_settings_version_id := v_policy_settings_version_id,
        p_winning_version := v_policy_version,
        p_scope_path := v_scope_path,
        p_inputs := jsonb_strip_nulls(jsonb_build_object(
            'webhook_id', p_webhook_id,
            'webhook_source_id', p_webhook_source_id,
            'sender_id', v_sender_id,
            'client_id', v_client_id,
            'recipient', v_recipient,
            'message_id', v_message_id
        )),
        p_merge_notes := NULL
    );

    -- Parse inbound timestamp (epoch seconds) when provided.
    BEGIN
      IF NULLIF(p_comm->>'timestamp', '') IS NOT NULL THEN
        v_inbound_at := to_timestamp((p_comm->>'timestamp')::DOUBLE PRECISION);
      END IF;
    EXCEPTION
      WHEN others THEN
        v_inbound_at := NULL;
    END;

    -- Resolve recipient_id for consent + disambiguation (client-scoped).
    IF v_client_id IS NOT NULL AND v_recipient IS NOT NULL THEN
        SELECT id
          INTO v_recipient_id
          FROM public.recipients
         WHERE client_id = v_client_id
           AND phone_number_normalized = v_recipient
         ORDER BY created_at DESC
         LIMIT 1;
    END IF;

    -- Record WhatsApp session start/refresh for compliance (inbound message opens a window).
    IF v_recipient_id IS NOT NULL THEN
      PERFORM public.touch_recipient_channel_session(v_recipient_id, 'whatsapp', v_inbound_at);
    END IF;

    IF v_recipient_id IS NOT NULL THEN
        SELECT opted_out
          INTO v_is_opted_out
          FROM public.recipient_preferences
         WHERE recipient_id = v_recipient_id
           AND channel = 'whatsapp'
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1;
        v_is_opted_out := COALESCE(v_is_opted_out, FALSE);
    END IF;

    -- Check for an active disambiguation session first (two-way).
    IF v_client_id IS NOT NULL AND v_recipient_id IS NOT NULL THEN
      SELECT id, requested_intent, state
        INTO v_session
        FROM public.comms_reply_sessions
       WHERE client_id = v_client_id
         AND recipient_id = v_recipient_id
         AND (webhook_source_id IS NULL OR webhook_source_id = p_webhook_source_id)
         AND session_type = 'shipment_disambiguation'
         AND resolved_at IS NULL
         AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1;

      IF FOUND THEN
        v_session_id := v_session.id;
        v_session_shipments := COALESCE(v_session.state->'shipments', '[]'::jsonb);
        v_intent := COALESCE(NULLIF(v_session.requested_intent, ''), 'fallback');

        v_selection_raw := NULLIF(p_comm->>'reply_payload', '');
        IF v_selection_raw IS NULL THEN
          v_selection_raw := NULLIF(p_comm->>'reply_text', '');
        END IF;

        v_selection_norm := NULL;
        IF v_selection_raw IS NOT NULL THEN
          v_selection_norm := regexp_replace(upper(btrim(v_selection_raw)), '[^A-Z0-9]', '', 'g');
        END IF;

        -- Numeric selection (1..N) or tracking number match.
        IF v_selection_norm IS NOT NULL AND v_selection_norm ~ '^[0-9]+$' THEN
          v_selected := (
            SELECT elem
            FROM jsonb_array_elements(v_session_shipments) WITH ORDINALITY AS t(elem, idx)
            WHERE t.idx = v_selection_norm::INT
            LIMIT 1
          );
        END IF;

        IF v_selected IS NULL AND v_selection_norm IS NOT NULL THEN
          v_selected := (
            SELECT elem
            FROM jsonb_array_elements(v_session_shipments) AS elem
            WHERE regexp_replace(upper(COALESCE(elem->>'tracking_number', '')), '[^A-Z0-9]', '', 'g') = v_selection_norm
            LIMIT 1
          );
        END IF;

        IF v_selected IS NOT NULL THEN
          BEGIN
            v_selected_shipment_id := NULLIF(v_selected->>'shipment_id', '')::UUID;
          EXCEPTION
            WHEN others THEN
              v_selected_shipment_id := NULL;
          END;

          IF v_selected_shipment_id IS NOT NULL THEN
            v_lookup_reason := 'disambiguation_session';
            v_shipment_id := v_selected_shipment_id;

            SELECT s.tracking_number,
                   s.status,
                   s.promised_delivery_date
              INTO v_shipment
              FROM public.shipments s
             WHERE s.id = v_selected_shipment_id
               AND s.organization_id = p_organization_id
               AND s.client_id = v_client_id
               AND (v_sender_id IS NULL OR s.sender_id = v_sender_id);

            IF FOUND THEN
              v_tracking := v_shipment.tracking_number;
              v_status := v_shipment.status;
              v_eta := CASE
                WHEN v_shipment.promised_delivery_date IS NOT NULL
                  THEN to_char(v_shipment.promised_delivery_date, 'YYYY-MM-DD')
                ELSE NULL
              END;

              UPDATE public.comms_reply_sessions
                 SET resolved_at = now(),
                     updated_at = now(),
                     state = jsonb_set(
                       COALESCE(state, '{}'::jsonb),
                       '{selection}',
                       jsonb_build_object(
                         'shipment_id', v_selected_shipment_id,
                         'tracking_number', v_tracking,
                         'raw', v_selection_raw
                       ),
                       TRUE
                     )
               WHERE id = v_session_id;
            ELSE
              v_error := 'disambiguation_shipment_not_found';
              v_shipment_id := NULL;
            END IF;
          END IF;
        END IF;

        IF v_selected IS NULL THEN
          v_lookup_reason := 'disambiguation_selection_invalid';
        END IF;
      END IF;
    END IF;

    -- Determine intent via keyword match (policy-driven), checking both text and payload,
    -- unless a disambiguation session already picked the intent.
    IF v_session_id IS NULL THEN
      v_match_text := trim(both ' ' FROM (v_reply_text || ' ' || v_reply_payload));
      FOR v_intent IN
          SELECT key
          FROM jsonb_object_keys(v_intents) AS key
          WHERE key <> 'fallback'
      LOOP
          IF EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(COALESCE(v_intents->v_intent->'keywords', '[]'::jsonb)) AS kw
              WHERE v_match_text LIKE '%' || lower(kw) || '%'
          ) THEN
              EXIT;
          END IF;
          v_intent := 'fallback';
      END LOOP;
    END IF;

    v_intent_cfg := COALESCE(v_intents->v_intent, '{}'::jsonb);
    v_template := NULLIF(v_intent_cfg->>'template', '');
    v_not_found_template := NULLIF(v_intent_cfg->>'not_found_template', '');
    v_requires_shipment := COALESCE(
        NULLIF(v_intent_cfg->>'requires_shipment', '')::BOOLEAN,
        (v_intent_cfg ? 'not_found_template')
    );
    v_stop_workflow := COALESCE(NULLIF(v_intent_cfg->>'stop_workflow', '')::BOOLEAN, FALSE);
    v_opt_out := COALESCE(NULLIF(v_intent_cfg->>'opt_out', '')::BOOLEAN, FALSE);
    v_allow_opted_out_send := COALESCE(NULLIF(v_intent_cfg->>'allow_opted_out_send', '')::BOOLEAN, v_opt_out);

    IF v_template IS NULL THEN
        RETURN jsonb_strip_nulls(jsonb_build_object(
            'status', 'skipped',
            'reason', 'template_missing',
            'intent', v_intent,
            'policy_scope', v_policy_scope_type
        ));
    END IF;

    -- Apply opt-out action if policy intent requires it.
    IF v_opt_out AND v_recipient_id IS NOT NULL THEN
        PERFORM public.set_recipient_opt_out(v_recipient_id, 'whatsapp', TRUE);
        v_is_opted_out := TRUE;
    END IF;

    -- Enforce opt-out (unless this intent explicitly allows sending while opted out).
    IF v_is_opted_out AND NOT v_allow_opted_out_send THEN
        v_error := 'recipient_opted_out';
    END IF;

    -- Shipment lookup when required (org + client + sender + normalized phone scoped), unless session picked a shipment.
    IF v_requires_shipment AND v_error IS NULL AND v_shipment_id IS NULL AND v_session_id IS NULL THEN
        IF p_organization_id IS NULL THEN
            v_lookup_reason := 'organization_missing_for_lookup';
        ELSIF v_client_id IS NULL THEN
            v_lookup_reason := 'client_missing_for_lookup';
        ELSIF v_recipient IS NOT NULL THEN
            -- Probe (limit 2) to detect ambiguity without requiring disambiguation config.
            WITH probe AS (
              SELECT s.id,
                     s.tracking_number,
                     s.status,
                     s.created_at
                FROM public.shipments s
                JOIN public.recipients r ON r.id = s.recipient_id
                   WHERE s.organization_id = p_organization_id
                     AND s.client_id = v_client_id
                     AND (v_sender_id IS NULL OR s.sender_id = v_sender_id)
                     AND r.client_id = v_client_id
                     AND r.organization_id = p_organization_id
                     AND r.phone_number_normalized = v_recipient
               ORDER BY s.created_at DESC
               LIMIT 2
            )
            SELECT
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'shipment_id', id,
                    'tracking_number', tracking_number,
                    'status', status
                  )
                  ORDER BY created_at DESC
                ),
                '[]'::jsonb
              ) AS shipments,
              count(*) AS n
              INTO v_session_shipments, v_match_n
            FROM probe;

            IF v_match_n = 0 THEN
              v_lookup_reason := 'shipment_not_found';
            ELSIF v_match_n = 1 THEN
              v_selected := v_session_shipments->0;
              BEGIN
                v_selected_shipment_id := NULLIF(v_selected->>'shipment_id', '')::UUID;
              EXCEPTION
                WHEN others THEN
                  v_selected_shipment_id := NULL;
              END;

              IF v_selected_shipment_id IS NOT NULL THEN
                v_lookup_reason := 'shipment_single_match';
                v_shipment_id := v_selected_shipment_id;

                SELECT s.tracking_number,
                       s.status,
                       s.promised_delivery_date
                  INTO v_shipment
                  FROM public.shipments s
                 WHERE s.id = v_selected_shipment_id
               AND s.organization_id = p_organization_id
               AND s.client_id = v_client_id
               AND (v_sender_id IS NULL OR s.sender_id = v_sender_id);

                IF FOUND THEN
                  v_tracking := v_shipment.tracking_number;
                  v_status := v_shipment.status;
                  v_eta := CASE
                    WHEN v_shipment.promised_delivery_date IS NOT NULL
                      THEN to_char(v_shipment.promised_delivery_date, 'YYYY-MM-DD')
                    ELSE NULL
                  END;
                END IF;
              END IF;
            ELSE
              -- Multiple shipments: disambiguation is policy-driven and only required in this branch.
              v_multi_cfg := COALESCE(v_intent_cfg->'multiple_shipments', '{}'::jsonb);
              v_multi_template := NULLIF(v_multi_cfg->>'template', '');
              v_multi_invalid_template := NULLIF(v_multi_cfg->>'invalid_selection_template', '');
              v_multi_ttl_seconds := NULLIF(v_multi_cfg->>'ttl_seconds', '')::INT;
              v_multi_max_options := NULLIF(v_multi_cfg->>'max_options', '')::INT;

              IF v_multi_template IS NULL THEN
                v_error := 'multiple_shipments_template_missing';
              ELSIF v_multi_ttl_seconds IS NULL OR v_multi_ttl_seconds <= 0 THEN
                v_error := 'multiple_shipments_ttl_invalid';
              ELSIF v_multi_max_options IS NULL OR v_multi_max_options <= 0 THEN
                v_error := 'multiple_shipments_max_options_invalid';
              ELSIF v_recipient_id IS NULL THEN
                v_error := 'recipient_unresolved_for_disambiguation';
              ELSE
                -- Fetch up to max_options+1 for options rendering; keep the list bounded.
                WITH matches AS (
                  SELECT s.id,
                         s.tracking_number,
                         s.status,
                         s.created_at
                    FROM public.shipments s
                    JOIN public.recipients r ON r.id = s.recipient_id
                   WHERE s.organization_id = p_organization_id
                 AND s.client_id = v_client_id
                 AND (v_sender_id IS NULL OR s.sender_id = v_sender_id)
                 AND r.client_id = v_client_id
                 AND r.organization_id = p_organization_id
                 AND r.phone_number_normalized = v_recipient
                   ORDER BY s.created_at DESC
                   LIMIT (v_multi_max_options + 1)
                )
                SELECT
                  COALESCE(
                    jsonb_agg(
                      jsonb_build_object(
                        'shipment_id', id,
                        'tracking_number', tracking_number,
                        'status', status
                      )
                      ORDER BY created_at DESC
                    ),
                    '[]'::jsonb
                  ) AS shipments,
                  count(*) AS n
                  INTO v_session_shipments, v_match_n
                FROM matches;

                IF jsonb_array_length(v_session_shipments) > v_multi_max_options THEN
                  v_has_more := TRUE;
                  SELECT COALESCE(jsonb_agg(elem ORDER BY idx), '[]'::jsonb)
                    INTO v_session_shipments
                    FROM jsonb_array_elements(v_session_shipments) WITH ORDINALITY AS t(elem, idx)
                    WHERE idx <= v_multi_max_options;
                END IF;

                v_session_id := public.create_comms_reply_shipment_disambiguation_session(
                  p_organization_id,
                  v_client_id,
                  p_webhook_source_id,
                  v_recipient_id,
                  v_recipient,
                  v_intent,
                  v_session_shipments,
                  v_multi_ttl_seconds
                );

                -- Render numbered options for the template context.
                SELECT string_agg(line, E'\n' ORDER BY idx)
                  INTO v_options_text
                  FROM (
                    SELECT
                      idx,
                      format('%s) %s', idx, COALESCE(elem->>'tracking_number', '')) AS line
                    FROM jsonb_array_elements(v_session_shipments) WITH ORDINALITY AS t(elem, idx)
                  ) AS x;

                v_message := v_multi_template;
                v_lookup_reason := 'multiple_shipments_disambiguation';
              END IF;
            END IF;
        END IF;
    END IF;

    IF v_requires_shipment AND v_error IS NULL AND v_shipment_id IS NULL AND v_message IS NULL AND v_session_id IS NULL THEN
        IF v_not_found_template IS NULL THEN
            v_error := 'not_found_template_missing';
        ELSE
            v_message := v_not_found_template;
        END IF;
    ELSIF v_message IS NULL THEN
        v_message := v_template;
    END IF;

    -- If we are in an active disambiguation session but selection was invalid, use policy templates.
    IF v_session_id IS NOT NULL AND v_shipment_id IS NULL AND v_lookup_reason = 'disambiguation_selection_invalid' THEN
      v_multi_cfg := COALESCE(v_intent_cfg->'multiple_shipments', '{}'::jsonb);
      v_multi_template := NULLIF(v_multi_cfg->>'template', '');
      v_multi_invalid_template := NULLIF(v_multi_cfg->>'invalid_selection_template', '');

      SELECT string_agg(line, E'\n' ORDER BY idx)
        INTO v_options_text
        FROM (
          SELECT
            idx,
            format('%s) %s', idx, COALESCE(elem->>'tracking_number', '')) AS line
          FROM jsonb_array_elements(v_session_shipments) WITH ORDINALITY AS t(elem, idx)
        ) AS x;

      IF v_multi_invalid_template IS NOT NULL THEN
        v_message := v_multi_invalid_template;
      ELSIF v_multi_template IS NOT NULL THEN
        v_message := v_multi_template;
      ELSE
        v_error := 'multiple_shipments_template_missing';
      END IF;
    END IF;

    -- Token rendering: support legacy {token} placeholders via {{token}} + render_template().
    v_render_context := jsonb_strip_nulls(jsonb_build_object(
        'tracking_number', v_tracking,
        'status', v_status,
        'eta', v_eta,
        'recipient', v_recipient,
        'message_id', v_message_id,
        'lookup_reason', v_lookup_reason,
        'shipment_options', v_options_text,
        'session_id', v_session_id,
        'has_more', v_has_more
    ));
    IF v_message IS NOT NULL THEN
        v_message := regexp_replace(v_message, '\{([A-Za-z0-9_]+)\}', '{{\1}}', 'g');
        v_message := trim(both '"' FROM public.render_template(to_jsonb(v_message), v_render_context)::TEXT);
    END IF;

    BEGIN
        v_corr := (p_comm->>'correlation_id')::UUID;
    EXCEPTION
        WHEN others THEN
            v_corr := NULL;
    END;

    -- Policy-driven rate limiting (only for actual sends).
    v_rate_cfg := COALESCE(v_policy->'reply_rate_limit', '{}'::jsonb);
    v_rate_enabled := COALESCE(NULLIF(v_rate_cfg->>'enabled', '')::BOOLEAN, FALSE);
    v_rate_window_seconds := NULLIF(v_rate_cfg->>'window_seconds', '')::INT;
    v_rate_max_replies := NULLIF(v_rate_cfg->>'max_replies', '')::INT;

    IF NOT v_dry_run AND v_error IS NULL THEN
        IF v_recipient IS NULL THEN
            v_error := 'recipient_missing';
        ELSIF v_auth_config_id IS NULL THEN
            v_error := 'auth_config_missing';
        ELSIF v_message IS NULL OR btrim(v_message) = '' THEN
            v_error := 'message_empty';
        ELSE
            IF v_rate_enabled THEN
              IF v_rate_window_seconds IS NULL OR v_rate_window_seconds <= 0 THEN
                v_error := 'reply_rate_limit_window_invalid';
              ELSIF v_rate_max_replies IS NULL OR v_rate_max_replies < 0 THEN
                v_error := 'reply_rate_limit_max_invalid';
              ELSE
                v_rate_result := public.check_and_increment_comms_reply_rate_limit(
                  p_organization_id,
                  p_webhook_source_id,
                  v_recipient,
                  v_rate_window_seconds,
                  v_rate_max_replies
                );
                IF NOT COALESCE((v_rate_result->>'allowed')::BOOLEAN, FALSE) THEN
                  v_error := COALESCE(v_rate_result->>'reason', 'rate_limited');
                END IF;
              END IF;
            END IF;

            IF v_error IS NULL THEN
              BEGIN
                  v_outbound_call_id := public.enqueue_comms_whatsapp(
                      v_auth_config_id,
                      v_recipient,
                      v_message,
                      v_corr,
                      v_shipment_id,
                      jsonb_strip_nulls(jsonb_build_object(
                          'source', 'send_comms_reply',
                          'webhook_id', p_webhook_id,
                          'webhook_source_id', p_webhook_source_id,
                          'organization_id', p_organization_id,
                          'sender_id', v_sender_id,
                          'client_id', v_client_id,
                          'recipient_id', v_recipient_id,
                          'intent', v_intent,
                          'opt_out', v_opt_out,
                          'allow_opted_out_send', v_allow_opted_out_send,
                          'policy_scope', v_policy_scope_type,
                          'message_id', v_message_id,
                          'session_id', v_session_id
                      ))
                  );
                  v_queued := v_outbound_call_id IS NOT NULL;
              EXCEPTION
                  WHEN others THEN
                      v_error := SQLERRM;
                      v_queued := FALSE;
              END;
            END IF;
        END IF;
    END IF;

    v_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'intent', v_intent,
        'message', v_message,
        'recipient', v_recipient,
        'recipient_id', v_recipient_id,
        'message_id', v_message_id,
        'shipment_id', v_shipment_id,
        'dry_run', v_dry_run,
        'queued', v_queued,
        'outbound_call_id', v_outbound_call_id,
        'requires_shipment', v_requires_shipment,
        'lookup_reason', v_lookup_reason,
        'stop_workflow', v_stop_workflow,
        'opt_out', v_opt_out,
        'error', v_error,
        'policy_scope', v_policy_scope_type,
        'settings_resolution_id', v_settings_resolution_id,
        'session_id', v_session_id,
        'rate_limit', v_rate_result
    ));

    PERFORM public.log_decision(
        p_organization_id := p_organization_id,
        p_decision_category := 'communication_reply',
        p_resource_type := 'webhook_inbox',
        p_resource_id := p_webhook_id,
        p_decision_point := 'auto_reply',
        p_decision_outcome := CASE
            WHEN v_error IS NOT NULL THEN 'reply_skipped'
            WHEN v_dry_run THEN 'reply_dry_run'
            WHEN v_queued THEN 'reply_queued'
            ELSE 'reply_pending'
        END,
        p_performed_by_system := 'comms_reply_workflow',
        p_correlation_id := v_corr,
        p_decision_inputs := v_decision_inputs,
        p_decision_reason := v_error,
        p_settings_resolution_id := v_settings_resolution_id
    );

    RETURN jsonb_strip_nulls(jsonb_build_object(
        'intent', v_intent,
        'message', v_message,
        'queued', v_queued,
        'outbound_call_id', v_outbound_call_id,
        'error', v_error,
        'shipment_id', v_shipment_id,
        'policy_scope', v_policy_scope_type,
        'settings_resolution_id', v_settings_resolution_id,
        'stop_workflow', v_stop_workflow,
        'opt_out', v_opt_out,
        'session_id', v_session_id,
        'rate_limit', v_rate_result
    ));
END;
$$;


COMMIT;
