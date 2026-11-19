import type { ToastTone } from '@/components/toastStore';

export type WebhookReplayToast = {
  message: string;
  tone: ToastTone;
};

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function webhookReplayWasPreserved(result: Record<string, unknown> | null | undefined): boolean {
  if (!result) return false;
  return readString(result, 'status') === 'preserved_terminal_failure'
    || result.replay_queued === false;
}

export function formatWebhookReplayToast(
  actionLabel: 'Retry' | 'Replay',
  result: Record<string, unknown> | null | undefined,
  eventReference: string,
): WebhookReplayToast {
  if (webhookReplayWasPreserved(result)) {
    return {
      message: `${actionLabel} not queued · terminal failure preserved · ${eventReference}`,
      tone: 'warn',
    };
  }

  return {
    message: `${actionLabel} queued · ${eventReference}`,
    tone: 'good',
  };
}
