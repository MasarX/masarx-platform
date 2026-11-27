import { render } from '@testing-library/react';
import { formatStatusBadge, pickupAssignmentModeLabel } from '../../packages/ui/src/pickup-page-shared';

jest.mock('@masarx/api/server', () => ({ createUiServerClient: jest.fn() }));
jest.mock('@masarx/auth/server', () => ({ createServerClient: jest.fn() }));

const cases = [
  ['en', { status: 'Pickup requested', failed: 'Pickup failed', mode: 'Internal driver', unknown: 'Unknown' }],
  ['ar', { status: 'تم طلب الاستلام', failed: 'فشل الاستلام', mode: 'سائق داخلي', unknown: 'غير معروف' }],
] as const;

afterEach(() => { delete process.env.NEXT_PUBLIC_LOCALE; });

describe.each(cases)('pickup status labels (%s)', (locale, expected) => {
  beforeEach(() => { process.env.NEXT_PUBLIC_LOCALE = locale; });

  it('shows translated status and assignment-mode labels, never the raw value', () => {
    const { container } = render(<>
      {formatStatusBadge('pickup_requested')}
      {formatStatusBadge('PICKUP_FAILED')}
      {formatStatusBadge('legacy_state')}
      {formatStatusBadge(null)}
      <span>{pickupAssignmentModeLabel('internal_driver')}</span>
    </>);
    const texts = Array.from(container.children, (node) => node.textContent);
    expect(texts).toEqual([expected.status, expected.failed, expected.unknown, expected.unknown, expected.mode]);
    expect(container.textContent).not.toMatch(/pickup_|legacy_state|internal_driver/i);
  });
});
