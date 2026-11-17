-- Plan: PLAN-202604-b06-closeout / Step: Allow text blocks without explicit dimensions in label publish gate

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102280_uc078_label_template_publish_gate_text_blocks_v1'));
SET search_path TO public, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.assert_label_template_published(
  p_template_id UUID,
  p_organization_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_status TEXT;
  v_errors JSONB;
  v_all_errors_allowed BOOLEAN := FALSE;
BEGIN
  SELECT validation_status, validation_errors
  INTO v_status, v_errors
  FROM label_template_validation
  WHERE template_id = p_template_id
    AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    PERFORM public.validate_label_template(p_template_id, p_organization_id, NULL);
    SELECT validation_status, validation_errors
    INTO v_status, v_errors
    FROM label_template_validation
    WHERE template_id = p_template_id
      AND organization_id = p_organization_id;
  END IF;

  IF v_status IS DISTINCT FROM 'passed' THEN
    IF v_status = 'failed' AND jsonb_typeof(COALESCE(v_errors, '[]'::jsonb)) = 'array' THEN
      SELECT NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(COALESCE(v_errors, '[]'::jsonb)) AS e
         WHERE NOT (
           e->>'code' = 'block_dim_invalid'
           AND lower(COALESCE(e->'block'->>'type', '')) = 'text'
         )
      )
        INTO v_all_errors_allowed;
    END IF;

    IF NOT v_all_errors_allowed THEN
      RAISE EXCEPTION 'Template % (org %) is not publishable: status=% errors=%', p_template_id, p_organization_id, COALESCE(v_status,'(missing)'), COALESCE(v_errors,'[]'::jsonb)
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.assert_label_template_published(UUID, UUID) IS
'Raises when label_template_validation is not passed for the given template/org (publish gate for label rendering), except for text blocks that omit explicit dimensions and only trip block_dim_invalid.';

SELECT pg_advisory_unlock(hashtext('202604102280_uc078_label_template_publish_gate_text_blocks_v1'));

COMMIT;
