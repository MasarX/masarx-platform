import { describe, expect, it } from 'vitest';
import { financeUrlScopeLabel } from '../_scope';

describe('finance scope labels', () => {
  it('uses the partner display name before legal name for operator handoff labels', () => {
    expect(
      financeUrlScopeLabel(
        { kind: 'partner', id: 'aa00bd85-fc79-4adb-afde-8b928f499753' },
        [
          {
            id: 'aa00bd85-fc79-4adb-afde-8b928f499753',
            display_name: 'Browser Driver Approve 20260521',
            legal_name: 'Driver Approve Live 1779332907609',
          },
        ],
      ),
    ).toBe('Scoped partner Browser Driver Approve 20260521');
  });
});
