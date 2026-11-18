"use client";

import * as React from "react";
import { Button } from "../button";
import { Input } from "../input";
import { Textarea } from "../textarea";
import { Badge } from "../badge";
import { cn } from "../utils";

type WebhookTestResult = {
  status: number;
  statusText: string;
  headers?: Record<string, string>;
  body?: string | null;
  durationMs: number;
};

type WebhookTesterProps = {
  defaultUrl?: string;
  defaultPayload?: string;
  onSendTest?: (url: string, payload: string) => Promise<WebhookTestResult>;
  className?: string;
};

/**
 * Webhook testing tool for sending test payloads and viewing responses.
 * Integrates into the integration management section.
 */
export function WebhookTester({
  defaultUrl = "",
  defaultPayload = '{\n  "event": "test",\n  "data": {}\n}',
  onSendTest,
  className,
}: WebhookTesterProps) {
  const [url, setUrl] = React.useState(defaultUrl);
  const [payload, setPayload] = React.useState(defaultPayload);
  const [result, setResult] = React.useState<WebhookTestResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);

  const handleSend = async () => {
    if (!url.trim() || !onSendTest) return;
    setSending(true);
    setResult(null);
    setError(null);
    try {
      const res = await onSendTest(url.trim(), payload);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setSending(false);
    }
  };

  const statusTone =
    result?.status && result.status >= 200 && result.status < 300
      ? "success"
      : result?.status && result.status >= 400
        ? "danger"
        : "warning";

  return (
    <div className={cn("space-y-4", className)}>
      <div className="space-y-3">
        <div>
          <label className="text-xs tracking-wide text-ui-muted">
            Webhook URL
          </label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/webhook"
            disabled={sending}
          />
        </div>
        <div>
          <label className="text-xs tracking-wide text-ui-muted">
            Payload (JSON)
          </label>
          <Textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            rows={6}
            className="font-mono text-xs"
            disabled={sending}
          />
        </div>
        <Button onClick={handleSend} disabled={!url.trim() || sending} loading={sending}>
          Send test webhook
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg border border-[rgb(var(--ui-danger)/0.3)] bg-[rgb(var(--ui-danger)/0.05)] p-3 text-sm text-[rgb(var(--ui-danger))]">
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="space-y-2 rounded-lg border border-ui-border/40 bg-ui-surface p-4">
          <div className="flex items-center gap-3">
            <Badge tone={statusTone} size="sm" dot>
              {result.status} {result.statusText}
            </Badge>
            <span className="text-xs text-ui-muted">{result.durationMs}ms</span>
          </div>
          {result.body ? (
            <pre className="max-h-48 overflow-auto rounded-lg bg-ui-highlight/50 p-3 text-xs text-ui-ink">
              {result.body}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
