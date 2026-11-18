import * as api from '@/lib/api';
import type { WebhookSourceDirectoryRow, WebhookSourceRow } from './sources';

export interface ExpectedWebhookSourceReadback {
  source_id?: string | null;
  name: string;
  source_identifier: string;
  provider_type?: string | null;
  mapping_config_id?: string | null;
  sender_id?: string | null;
  rate_limit_per_hour?: number | null;
  enabled: boolean;
  hmac_enabled: boolean;
  hmac_auth_config_id?: string | null;
  hmac_header?: string | null;
}

export async function requireWebhookSourceReadback(args: {
  result: Awaited<ReturnType<typeof api.ui_upsert_webhook_source_v1>>;
  expected: ExpectedWebhookSourceReadback;
}): Promise<{
  source: WebhookSourceRow;
  directory: WebhookSourceDirectoryRow;
}> {
  const sourceId = String(args.result.webhook_source_id ?? args.expected.source_id ?? '').trim();
  if (!sourceId) {
    throw new Error('Webhook source save did not return a canonical source id.');
  }
  const [source, directory] = await Promise.all([
    api.ui_get_resource_v1<WebhookSourceRow>('webhook_sources', sourceId),
    api.ui_get_resource_v1<WebhookSourceDirectoryRow>('webhook_source_directory', sourceId),
  ]);
  if (!source?.id || source.id !== sourceId) {
    throw new Error(`Webhook source ${sourceId} is not readable from the backend.`);
  }
  if (!directory?.id || directory.id !== sourceId) {
    throw new Error(`Webhook source ${sourceId} directory projection is not readable from the backend.`);
  }
  const expected = args.expected;
  const mismatches: string[] = [];
  if (source.name !== expected.name) mismatches.push('name');
  if (source.source_identifier !== expected.source_identifier) mismatches.push('source reference');
  if (expected.provider_type && source.provider_type !== expected.provider_type) mismatches.push('provider');
  if ((source.mapping_config_id ?? null) !== (expected.mapping_config_id ?? null)) mismatches.push('mapping profile');
  if ((source.sender_id ?? null) !== (expected.sender_id ?? null)) mismatches.push('shipment sender');
  if (Boolean(source.enabled) !== expected.enabled || Boolean(directory.enabled) !== expected.enabled) {
    mismatches.push('enabled state');
  }
  if (
    expected.rate_limit_per_hour != null &&
    Number(source.rate_limit_per_hour) !== Number(expected.rate_limit_per_hour)
  ) {
    mismatches.push('rate limit');
  }
  if (Boolean(directory.hmac_enabled) !== expected.hmac_enabled) {
    mismatches.push('receiver auth mode');
  }
  if (
    expected.hmac_enabled &&
    (directory.hmac_auth_config_id ?? null) !== (expected.hmac_auth_config_id ?? null)
  ) {
    mismatches.push('HMAC credential');
  }
  if (
    expected.hmac_enabled &&
    String(directory.hmac_header ?? '').trim() !== String(expected.hmac_header ?? '').trim()
  ) {
    mismatches.push('HMAC header');
  }
  if (mismatches.length) {
    throw new Error(`Webhook source readback mismatch: ${mismatches.join(', ')}.`);
  }
  return { source, directory };
}

export async function requireWebhookSourceTokenReadback(sourceId: string): Promise<WebhookSourceDirectoryRow> {
  const directory = await api.ui_get_resource_v1<WebhookSourceDirectoryRow>('webhook_source_directory', sourceId);
  if (!directory?.id || directory.id !== sourceId) {
    throw new Error(`Webhook source ${sourceId} directory projection is not readable from the backend.`);
  }
  if (!directory.auth_token_masked) {
    throw new Error(`Webhook source ${sourceId} did not confirm a stored redacted token.`);
  }
  return directory;
}

export async function requireWebhookSourceStateReadback(
  sourceId: string,
  expected: { enabled?: boolean; archived?: boolean },
): Promise<{
  source: WebhookSourceRow;
  directory: WebhookSourceDirectoryRow;
}> {
  const [source, directory] = await Promise.all([
    api.ui_get_resource_v1<WebhookSourceRow>('webhook_sources', sourceId),
    api.ui_get_resource_v1<WebhookSourceDirectoryRow>('webhook_source_directory', sourceId),
  ]);
  if (!source?.id || source.id !== sourceId) {
    throw new Error(`Webhook source ${sourceId} is not readable from the backend.`);
  }
  if (!directory?.id || directory.id !== sourceId) {
    throw new Error(`Webhook source ${sourceId} directory projection is not readable from the backend.`);
  }
  if (
    typeof expected.enabled === 'boolean' &&
    (Boolean(source.enabled) !== expected.enabled || Boolean(directory.enabled) !== expected.enabled)
  ) {
    throw new Error(`Webhook source ${sourceId} backend readback did not reflect enabled state.`);
  }
  if (expected.archived) {
    const sourceLifecycle = source.lifecycle_state ?? source.managed_metadata?.lifecycle ?? null;
    const directoryLifecycle = directory.lifecycle_state ?? directory.managed_metadata?.lifecycle ?? null;
    if (
      (sourceLifecycle !== 'archived' && !source.archived_at) ||
      (directoryLifecycle !== 'archived' && !directory.archived_at)
    ) {
      throw new Error(`Webhook source ${sourceId} backend readback did not expose archive state.`);
    }
  }
  return { source, directory };
}
