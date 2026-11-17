-- Plan: PLAN-202601-address-versioned-addresses-pitch-progress / Step: S01

-- geocoding_normalize_candidate_code: prevent truncation on clean alphanumeric inputs
--
-- Rationale:
-- - We want safe normalization + strict validation by default.
-- - Substring extraction is only safe when the original candidate included noise
--   (whitespace/punctuation) and we need to recover the embedded code.
-- - For clean alphanumeric inputs (e.g., OCR/AI can add an extra leading letter),
--   substring extraction can create false positives; return NULL instead.

CREATE OR REPLACE FUNCTION public.geocoding_normalize_candidate_code(
    p_candidate TEXT,
    p_code_regex TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_raw TEXT;
    v_norm TEXT;
    v_search_regex TEXT;
    v_match TEXT;
BEGIN
    v_raw := NULLIF(trim(COALESCE(p_candidate, '')), '');
    IF v_raw IS NULL THEN
        RETURN NULL;
    END IF;

    -- Normalize by stripping non-alphanumerics and uppercasing.
    v_norm := NULLIF(
        upper(
            regexp_replace(
                v_raw,
                '[^A-Za-z0-9]',
                '',
                'g'
            )
        ),
        ''
    );

    IF v_norm IS NULL THEN
        RETURN NULL;
    END IF;

    IF p_code_regex IS NULL OR p_code_regex = '' THEN
        RETURN v_norm;
    END IF;

    -- First: strict validation against the supplied regex.
    BEGIN
        IF v_norm ~ p_code_regex THEN
            RETURN v_norm;
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            RETURN NULL;
    END;

    -- Guard: only attempt substring extraction when the original candidate included
    -- non-alphanumeric characters (noise). For clean alphanumeric candidates,
    -- substring extraction can create incorrect-but-matching codes.
    IF v_raw ~ '^[A-Za-z0-9]+$' THEN
        RETURN NULL;
    END IF;

    -- Second: attempt substring extraction by removing anchors (when present).
    v_search_regex := p_code_regex;
    IF left(v_search_regex, 1) = '^' THEN
        v_search_regex := substr(v_search_regex, 2);
    END IF;
    IF right(v_search_regex, 1) = '$' THEN
        v_search_regex := left(v_search_regex, length(v_search_regex) - 1);
    END IF;

    v_search_regex := NULLIF(v_search_regex, '');
    IF v_search_regex IS NULL THEN
        RETURN NULL;
    END IF;

    BEGIN
        v_match := NULLIF((regexp_match(v_norm, v_search_regex))[1], '');
    EXCEPTION
        WHEN OTHERS THEN
            v_match := NULL;
    END;

    IF v_match IS NULL THEN
        RETURN NULL;
    END IF;

    BEGIN
        IF v_match ~ p_code_regex THEN
            RETURN v_match;
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            RETURN NULL;
    END;

    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.geocoding_normalize_candidate_code(TEXT, TEXT)
  IS 'Normalize candidate address code by stripping non-alphanumerics and uppercasing; validates by regex, and only extracts a matching substring when the original candidate contained non-alphanumeric noise (returns NULL on mismatch or invalid regex).';
