-- Migration: prevent draft invoice header totals from drifting away from lines.
--
-- If a draft invoice has line items, the line amounts are the total source for
-- the operator workflow. Direct header-total edits that disagree with line
-- totals are rejected so Console and API callers cannot leave contradictory
-- invoice state behind.

BEGIN;

CREATE OR REPLACE FUNCTION public.assert_billing_invoice_line_total_alignment_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_line_count integer;
  v_line_total numeric;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF NEW.status <> 'draft' THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::integer,
         COALESCE(sum(COALESCE(amount, quantity * unit_price)), 0)
    INTO v_line_count, v_line_total
    FROM public.billing_invoice_lines
   WHERE invoice_id = NEW.id;

  IF v_line_count > 0 AND COALESCE(NEW.total, 0) <> v_line_total THEN
    RAISE EXCEPTION 'billing invoice total % must match line total % when invoice has % line(s)',
      NEW.total, v_line_total, v_line_count
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_invoice_line_total_alignment_v1 ON public.billing_invoices;

CREATE TRIGGER trg_billing_invoice_line_total_alignment_v1
BEFORE UPDATE OF subtotal, tax_total, total ON public.billing_invoices
FOR EACH ROW
EXECUTE FUNCTION public.assert_billing_invoice_line_total_alignment_v1();

COMMENT ON FUNCTION public.assert_billing_invoice_line_total_alignment_v1() IS
  'Rejects draft billing invoice header totals that disagree with existing line totals.';

COMMIT;
