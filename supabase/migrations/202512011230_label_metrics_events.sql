-- Create metrics_webhook_events to capture label renderer metric emissions (internal SSOT).
CREATE TABLE IF NOT EXISTS metrics_webhook_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    metric text NOT NULL,
    labels jsonb DEFAULT '{}'::jsonb,
    data jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE metrics_webhook_events ENABLE ROW LEVEL SECURITY;

-- Allow service_role (and edge_label_renderer_role, if present) to insert/select for observability.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'metrics_webhook_events'
      AND policyname = 'metrics_events_service_role'
  ) THEN
    CREATE POLICY metrics_events_service_role
      ON metrics_webhook_events
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'metrics_webhook_events'
        AND policyname = 'metrics_events_edge_renderer'
    ) THEN
      CREATE POLICY metrics_events_edge_renderer
        ON metrics_webhook_events
        FOR ALL
        TO edge_label_renderer_role
        USING (true)
        WITH CHECK (true);
    END IF;
  END IF;
END;
$$;
