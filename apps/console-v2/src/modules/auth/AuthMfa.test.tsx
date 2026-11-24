import type { ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { AuthMfa } from '@masarx/ui/auth-mfa';

const code = String(1200 * 132 + 90);
const factorId = 'test-factor';

function renderMfa(hasFactor: boolean) {
  const listFactors = vi.fn().mockResolvedValue({
    data: { totp: hasFactor ? [{ id: factorId }] : [], all: [] },
    error: null,
  });
  const enroll = vi.fn().mockResolvedValue({
    data: { id: factorId, totp: { qr_code: 'data:image/svg+xml,%3Csvg%2F%3E', secret: 'sample-setup-key' } },
    error: null,
  });
  const challengeAndVerify = vi.fn().mockResolvedValue({ data: {}, error: null });
  const onVerified = vi.fn();
  const mfa = { listFactors, enroll, challengeAndVerify } as unknown as ComponentProps<typeof AuthMfa>['mfa'];
  render(
    <NextIntlClientProvider locale="en">
      <AuthMfa mfa={mfa} onVerified={onVerified} onSignOut={vi.fn()} />
    </NextIntlClientProvider>,
  );
  return { enroll, challengeAndVerify, onVerified };
}

describe('authenticator verification', () => {
  it('enrolls a new factor and verifies its first code', async () => {
    const user = userEvent.setup();
    const { enroll, challengeAndVerify, onVerified } = renderMfa(false);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('img', { name: 'Authenticator setup QR code' })).toBeInTheDocument();
    expect(enroll).toHaveBeenCalledWith({ factorType: 'totp' });
    expect(onVerified).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Six-digit authenticator code'), code);
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(challengeAndVerify).toHaveBeenCalledWith({ factorId, code });
    expect(onVerified).toHaveBeenCalledOnce();
    expect(screen.queryByText('sample-setup-key')).not.toBeInTheDocument();
  });

  it('challenges a verified factor and keeps the session blocked when verification fails', async () => {
    const user = userEvent.setup();
    const { enroll, challengeAndVerify, onVerified } = renderMfa(true);
    challengeAndVerify.mockResolvedValueOnce({ error: new Error('Rejected for test') });

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('Six-digit authenticator code'), code);
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(enroll).not.toHaveBeenCalled();
    expect(challengeAndVerify).toHaveBeenCalledWith({ factorId, code });
    expect(await screen.findByRole('alert')).toHaveTextContent('Verification failed');
    expect(onVerified).not.toHaveBeenCalled();
  });
});
