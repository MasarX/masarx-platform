import { describe, it, expect, beforeEach } from 'vitest';
import { clearToasts, getToasts, pushToast } from './toastStore';

describe('toastStore', () => {
  beforeEach(() => {
    clearToasts();
  });

  it('keeps normal operator copy unchanged', () => {
    pushToast('Saved and synced', 'good');
    expect(getToasts()[0]?.message).toBe('Saved and synced');
  });

  it('does not expose technical backend wording in toast copy', () => {
    pushToast('ui_create_shipment_v1 backend readback missing shipment_id', 'danger');
    expect(getToasts()[0]?.message).toBe(
      'The action could not be completed. Please try again or contact an administrator.',
    );
  });
});
