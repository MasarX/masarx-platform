-- Driver application review timeline metadata.
-- Keeps Console V2 decision timelines row-driven instead of rendering
-- missing event-type or summary-template fallbacks after live review actions.

DO $$
DECLARE
  v_definition_id uuid;
BEGIN
  SELECT id
  INTO v_definition_id
  FROM public.lookup_definitions
  WHERE category = 'marketplace_participant_request_status'
  LIMIT 1;

  IF v_definition_id IS NULL THEN
    INSERT INTO public.lookup_definitions (category, description, status, metadata)
    VALUES (
      'marketplace_participant_request_status',
      'Marketplace participant request lifecycle status',
      'active',
      '{}'::jsonb
    )
    RETURNING id INTO v_definition_id;
  END IF;

  INSERT INTO public.lookup_values (
    lookup_definition_id,
    value,
    label,
    status,
    sort_order,
    metadata
  )
  VALUES
    (
      v_definition_id,
      'approved',
      'Approved',
      'active',
      20,
      jsonb_build_object(
        'tone', 'good',
        'allowed_actions', jsonb_build_array(),
        'review_summary_template', 'Application approved - invite redirected to {invite_redirect_to|driver}',
        'decision_event_type', 'application.approved'
      )
    ),
    (
      v_definition_id,
      'rejected',
      'Rejected',
      'active',
      30,
      jsonb_build_object(
        'tone', 'danger',
        'allowed_actions', jsonb_build_array(),
        'review_summary_template', 'Application rejected - {review_reason|no reason}',
        'decision_event_type', 'application.rejected'
      )
    )
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
  SET
    label = EXCLUDED.label,
    status = EXCLUDED.status,
    sort_order = EXCLUDED.sort_order,
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();
END $$;
