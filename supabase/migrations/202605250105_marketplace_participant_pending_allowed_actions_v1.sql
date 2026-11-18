-- Console V2 participant application drawer actions resolve from canonical
-- lookup metadata. Pending requests must expose their row-driven review
-- actions so the drawer can fail closed without hardcoded status branches.

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
    INSERT INTO public.lookup_definitions (category, description, scope_type, owner_role, approval_policy, is_mutable)
    VALUES (
      'marketplace_participant_request_status',
      'Marketplace participant request lifecycle status',
      'global',
      'engineering',
      'tier_1',
      FALSE
    )
    RETURNING id INTO v_definition_id;
  END IF;

  INSERT INTO public.lookup_values (
    lookup_definition_id,
    value,
    label,
    description,
    sort_order,
    is_default,
    status,
    metadata
  )
  VALUES (
    v_definition_id,
    'pending',
    'Pending',
    'Participant request awaiting review.',
    10,
    TRUE,
    'active',
    jsonb_build_object(
      'tone', 'info',
      'allowed_actions', jsonb_build_array('approve', 'reject')
    )
  )
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
  SET
    label = EXCLUDED.label,
    description = COALESCE(public.lookup_values.description, EXCLUDED.description),
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = EXCLUDED.status,
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'tone', 'info',
        'allowed_actions', jsonb_build_array('approve', 'reject')
      ),
    updated_at = now();

  UPDATE public.lookup_values v
  SET
    metadata = COALESCE(v.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'tone', 'info',
        'allowed_actions', jsonb_build_array('approve', 'reject')
      ),
    updated_at = now()
  FROM public.lookup_definitions d
  WHERE d.id = v.lookup_definition_id
    AND d.category = 'marketplace_participant_request_status'
    AND v.value = 'pending';
END $$;
