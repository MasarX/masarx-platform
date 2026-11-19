import { useState } from 'react';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';

interface ImportCancelReasonFormProps {
  jobId: string;
  jobStatus?: string | null;
  entityLabel?: string;
  bodyText?: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}

export function ImportCancelReasonForm({
  jobId,
  jobStatus,
  entityLabel = 'Job',
  bodyText = 'Cancelling stops the active import job and saves the operator reason with the job.',
  onClose,
  onSubmit,
}: ImportCancelReasonFormProps) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const trimmedReason = reason.trim();

  async function submit() {
    if (!trimmedReason) {
      setError('Enter the operator reason before cancelling this import job.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmedReason);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div data-testid="imports-cancel-modal">
      <p className="state__hint">
        {bodyText}
      </p>
      {error ? (
        <StateView
          kind="error"
          title="Import cancellation failed"
          hint={error}
        />
      ) : null}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '128px 1fr',
          gap: 10,
          alignItems: 'center',
          padding: '0 4px',
          marginTop: 8,
        }}
      >
        <span className="mono">{entityLabel}</span>
        <span className="mono">{jobId}</span>
        <span className="mono">Current status</span>
        <span>{jobStatus || '-'}</span>
        <label className="mono" htmlFor="import-cancel-reason">Reason</label>
        <input
          id="import-cancel-reason"
          className="dt-inline-input"
          aria-label="Cancellation reason"
          value={reason}
          disabled={submitting}
          placeholder="Why is this import being cancelled?"
          onChange={(event) => {
            setReason(event.target.value);
            if (error) setError(null);
          }}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <Button label="Close" kind="ghost" disabled={submitting} onClick={onClose} />
        <Button
          label="Confirm cancellation"
          iconName="close"
          kind="danger"
          disabled={!trimmedReason || submitting}
          onClick={submit}
        />
      </div>
    </div>
  );
}
