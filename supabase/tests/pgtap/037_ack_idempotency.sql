-- Test Suite: webhook acknowledgement idempotency and persistence

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

DO $$
DECLARE
  v_provider_type TEXT;
BEGIN
  SELECT lv.value
    INTO v_provider_type
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv
      ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'integration_type'
     AND COALESCE(lv.status, 'active') = 'active'
   ORDER BY COALESCE(lv.sort_order, 2147483647), lv.value
   LIMIT 1;

  v_provider_type := COALESCE(v_provider_type, 'provider');

  UPDATE public.webhook_sources
     SET provider_type = v_provider_type,
         updated_at = now()
   WHERE provider_type = 'test'
      OR auth_token IN ('client-a-ack-token');
END;
$$;

CREATE TEMP TABLE tmp_webhook_payload (
    event_id TEXT PRIMARY KEY,
    payload JSONB
);

INSERT INTO tmp_webhook_payload (event_id, payload)
SELECT
    gen_random_uuid()::text AS event_id,
    jsonb_build_object(
        'event', jsonb_build_object('id', gen_random_uuid()::text, 'type', 'shipment.created')
    )
FROM generate_series(1, 1);

UPDATE tmp_webhook_payload
SET payload = jsonb_set(
    payload,
    '{event,id}',
    to_jsonb(event_id)
);

CREATE TEMP TABLE tmp_webhook_response (
    event_id TEXT NOT NULL,
    attempt INT NOT NULL,
    response JSONB NOT NULL
);

INSERT INTO tmp_webhook_response (event_id, attempt, response)
SELECT
    p.event_id,
    1,
    workflow_intake_webhook(
        'client-a-ack-token',
        jsonb_build_object('content-type', 'application/json'),
        to_jsonb(p.payload)::text,
        p.payload
    )
FROM tmp_webhook_payload p;

INSERT INTO tmp_webhook_response (event_id, attempt, response)
SELECT
    p.event_id,
    2,
    workflow_intake_webhook(
        'client-a-ack-token',
        jsonb_build_object('content-type', 'application/json'),
        to_jsonb(p.payload)::text,
        p.payload
    )
FROM tmp_webhook_payload p;

SELECT is(
    (
        SELECT response->>'response_outcome'
        FROM tmp_webhook_response
        WHERE attempt = 1
    ),
    'response_sent',
    'First acknowledgement attempt emits HTTP response'
);

SELECT is(
    (
        SELECT response->>'response_outcome'
        FROM tmp_webhook_response
        WHERE attempt = 2
    ),
    'response_replayed',
    'Second acknowledgement attempt replays stored response'
);

SELECT is(
    (
        SELECT idempotency_key
        FROM webhook_ack_history
        WHERE webhook_inbox_id = (
            SELECT (response->>'webhook_id')::uuid
            FROM tmp_webhook_response
            WHERE attempt = 1
        )
        ORDER BY ack_sent_at DESC
        LIMIT 1
    ),
    (
        SELECT event_id FROM tmp_webhook_payload
    ),
    'Stored acknowledgement trims idempotency key to raw event id'
);

SELECT is(
    (
        SELECT ack_body
        FROM webhook_ack_history
        WHERE webhook_inbox_id = (
            SELECT (response->>'webhook_id')::uuid
            FROM tmp_webhook_response
            WHERE attempt = 1
        )
        ORDER BY ack_sent_at DESC
        LIMIT 1
    ),
    (
        SELECT response->'body'
        FROM tmp_webhook_response
        WHERE attempt = 1
    ),
    'Persisted acknowledgement body matches original response payload'
);

SELECT * FROM finish();

ROLLBACK;
